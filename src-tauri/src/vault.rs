//! The window's single vault: state, epoch, the path guard and `vault_open`
//! (ARCHITECTURE §6.1, PLAT-08).

use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::fs_ops::SelfWrites;
use crate::{store, watcher};

/// Result of `vault_open` (`VaultInfo` in src/lib/types.ts).
#[derive(Debug, Clone, Serialize)]
pub struct VaultInfo {
    /// Canonical root with OS-native separators.
    pub root: String,
    pub name: String,
    pub epoch: u64,
}

/// The active vault folder.
#[derive(Debug, Clone)]
struct Root {
    path: PathBuf,
    /// Unix: the folder was a mount point when opened, or at any `check` since
    /// (latched, so a vault opened before its volume was mounted is protected from
    /// the first command after the mount on). Once it sits on its parent's device
    /// again, the volume is unmounted and the bare mount-point folder shows
    /// through, which must never be filled (VAULT-06).
    mount_point: bool,
}

/// Process-wide vault state, managed by Tauri. No lock is ever held across file I/O.
pub struct VaultState {
    /// Guarded together with `epoch`: both change under the write lock, and
    /// `root_for` reads both under the read lock, so a command can never pair an
    /// old epoch with a new root.
    root: RwLock<Option<Root>>,
    epoch: AtomicU64,
    watcher: Mutex<Option<watcher::VaultWatcher>>,
    registry: Mutex<SelfWrites>,
    /// Bumped by every search (and vault switch); a running search stops when it changes.
    pub search_gen: AtomicU64,
    /// Set when the frontend has flushed (or the fallback fired); exit is no longer prevented.
    pub exit_ready: AtomicBool,
    /// Set once the exit fallback timer is armed, so repeated quit requests arm it once.
    pub exit_pending: AtomicBool,
    /// Serializes `vault_open` calls.
    open_lock: Mutex<()>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            root: RwLock::new(None),
            epoch: AtomicU64::new(0),
            watcher: Mutex::new(None),
            registry: Mutex::new(SelfWrites::default()),
            search_gen: AtomicU64::new(0),
            exit_ready: AtomicBool::new(false),
            exit_pending: AtomicBool::new(false),
            open_lock: Mutex::new(()),
        }
    }
}

impl VaultState {
    /// Epoch of the active vault (0 before the first `vault_open`).
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The active root if `epoch` is current (`no_vault` otherwise). Does not
    /// touch the filesystem, so recovery copies still work while the root is gone.
    pub fn root_for(&self, epoch: u64) -> AppResult<PathBuf> {
        self.current(epoch).map(|root| root.path)
    }

    fn current(&self, epoch: u64) -> AppResult<Root> {
        let root = self.root.read().unwrap_or_else(PoisonError::into_inner);
        match root.as_ref() {
            Some(root) if self.epoch() == epoch => Ok(root.clone()),
            _ => Err(AppError::new(
                ErrorKind::NoVault,
                "no vault open for this request",
            )),
        }
    }

    /// `check(epoch)` from ARCHITECTURE §6.1: a current epoch and a reachable root
    /// directory (`root_unavailable` for an unmounted or deleted root, including
    /// a mount-point root whose volume is gone but whose empty folder remains).
    pub fn check(&self, epoch: u64) -> AppResult<PathBuf> {
        let root = self.current(epoch)?;
        let available = match fs::metadata(&root.path) {
            Ok(meta) if meta.is_dir() => match is_mount_point(&root.path, &meta) {
                Some(true) => {
                    if !root.mount_point {
                        self.latch_mount_point(epoch);
                    }
                    true
                }
                Some(false) => !root.mount_point,
                None => true,
            },
            _ => false,
        };
        if available {
            Ok(root.path)
        } else {
            Err(AppError::new(
                ErrorKind::RootUnavailable,
                "the vault folder is not available",
            ))
        }
    }

    /// Marks the root of `epoch` as a mount point once a `check` has seen it on
    /// another device than its parent, so every later unmount is caught even when
    /// the vault was opened before its volume was mounted (VAULT-06). The flag
    /// lives in `Root`, so the next `activate` resets it. No I/O under the lock.
    fn latch_mount_point(&self, epoch: u64) {
        let mut slot = self.root.write().unwrap_or_else(PoisonError::into_inner);
        // The epoch only changes together with the root, under this lock.
        if self.epoch() == epoch {
            if let Some(root) = slot.as_mut() {
                root.mount_point = true;
            }
        }
    }

    /// The self-write registry (lock it briefly; never across file I/O).
    pub fn registry(&self) -> MutexGuard<'_, SelfWrites> {
        lock(&self.registry)
    }

    /// Makes `root` the active vault: bumps the epoch, clears the registry, cancels
    /// running searches and hands back the previous watcher for the caller to drop.
    fn activate(&self, root: Root) -> (u64, Option<watcher::VaultWatcher>) {
        let mut slot = lock(&self.watcher);
        let epoch = {
            let mut current = self.root.write().unwrap_or_else(PoisonError::into_inner);
            *current = Some(root);
            self.epoch.fetch_add(1, Ordering::SeqCst) + 1
        };
        self.registry().clear();
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        (epoch, slot.take())
    }

    /// Installs a freshly started watcher unless a newer vault was opened meanwhile.
    fn install_watcher(&self, epoch: u64, watcher: watcher::VaultWatcher) {
        let stale = {
            let mut slot = lock(&self.watcher);
            if self.epoch() == epoch {
                *slot = Some(watcher);
                None
            } else {
                Some(watcher)
            }
        };
        drop(stale);
    }

    /// Stops the watcher (app exit).
    pub fn stop_watcher(&self) {
        let old = lock(&self.watcher).take();
        drop(old);
    }
}

/// Locks a mutex, ignoring poisoning (state stays usable after an unexpected panic).
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Unix: whether the folder `dir` (with metadata `meta`) is a mount point, i.e. on
/// another device than its parent. `None` when that cannot be told: no parent, an
/// unreadable parent, or another platform. Device numbers are only compared with
/// the parent's, never stored, since a remount may get a new one.
fn is_mount_point(dir: &Path, meta: &fs::Metadata) -> Option<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let parent = fs::metadata(dir.parent()?).ok()?;
        Some(parent.dev() != meta.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, meta);
        None
    }
}

/// Runs blocking work on Tauri's blocking pool with access to the vault state.
pub async fn blocking<T, F>(app: AppHandle, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&VaultState) -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || match app.try_state::<VaultState>() {
        Some(state) => work(&state),
        None => Err(AppError::new(ErrorKind::Io, "vault state is not available")),
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, format!("background task failed: {e}")))?
}

fn invalid_path(rel: &str) -> AppError {
    AppError::new(
        ErrorKind::InvalidPath,
        format!("invalid vault path: {rel:?}"),
    )
}

/// Lexical guard for a `VaultPath` (no filesystem access): splits it on `/` and
/// rejects empty, `.` and `..` components, NUL, and anything that is not a single
/// plain name. On Windows it also rejects characters and names Windows cannot
/// store; on Unix `\` and `:` are ordinary name characters. `""` is the root.
pub fn split_rel(rel: &str) -> AppResult<Vec<&str>> {
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().all(|c| is_valid_component(c)) {
        Ok(parts)
    } else {
        Err(invalid_path(rel))
    }
}

fn is_valid_component(c: &str) -> bool {
    if c.is_empty() || c == "." || c == ".." || c.contains('\0') {
        return false;
    }
    if cfg!(windows) && !is_valid_windows_component(c) {
        return false;
    }
    let mut parts = Path::new(c).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(n)), None) if n == OsStr::new(c))
}

/// Windows-only name rules: no `<>:"/\|?*` or control characters, no trailing dot
/// or space (Win32 strips them, aliasing another name), no reserved device name.
fn is_valid_windows_component(c: &str) -> bool {
    !c.chars().any(|ch| ch < ' ' || "<>:\"/\\|?*".contains(ch))
        && !c.ends_with('.')
        && !c.ends_with(' ')
        && !is_windows_reserved(c)
}

/// `CON`, `NUL`, `COM1`, `LPT¹`, `CONIN$`… matched on the part before the first
/// dot, trailing spaces removed, case ignored (TREE-07).
fn is_windows_reserved(c: &str) -> bool {
    let base = c
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    match base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"))
    {
        Some(rest) => {
            matches!(rest, "¹" | "²" | "³")
                || (rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
        }
        None => false,
    }
}

/// `vault::resolve`: joins a `VaultPath` onto the root after the lexical guard and
/// rejects it when any existing component is a symlink or junction (one
/// `symlink_metadata` per existing prefix).
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let parts = split_rel(rel)?;
    let mut path = root.to_path_buf();
    let mut probing = true;
    for part in parts {
        path.push(part);
        if probing {
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(AppError::new(
                        ErrorKind::InvalidPath,
                        format!("path goes through a symlink: {rel:?}"),
                    ));
                }
                Ok(_) => {}
                // Missing (nothing deeper exists either) or unreadable (any
                // operation below fails on its own).
                Err(_) => probing = false,
            }
        }
    }
    Ok(path)
}

/// Joins an already validated `VaultPath` (e.g. one produced by [`to_rel`]) onto
/// the root without touching the filesystem.
pub fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// `abs` as a `VaultPath`: root stripped, components joined with `/`. `None` when
/// `abs` is outside the root or a component is not valid UTF-8.
pub fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(root).ok()?;
    let mut rel = String::new();
    for part in rest.components() {
        match part {
            Component::Normal(name) => {
                if !rel.is_empty() {
                    rel.push('/');
                }
                rel.push_str(name.to_str()?);
            }
            _ => return None,
        }
    }
    Some(rel)
}

/// Opens a folder as the vault (ARCHITECTURE §5): canonicalize, require a readable
/// directory, bump the epoch, allow the asset scope, restart the watcher, prune
/// old recovery copies.
#[tauri::command]
pub async fn vault_open(app: AppHandle, path: String) -> AppResult<VaultInfo> {
    let handle = app.clone();
    blocking(app, move |state| open(&handle, state, &path)).await
}

fn open(app: &AppHandle, state: &VaultState, path: &str) -> AppResult<VaultInfo> {
    let _serial = lock(&state.open_lock);
    if !Path::new(path).is_absolute() {
        return Err(AppError::new(
            ErrorKind::InvalidPath,
            "the vault path must be absolute",
        ));
    }
    let root = dunce::canonicalize(path).map_err(|e| AppError::from_io(e, "open vault"))?;
    let meta = fs::metadata(&root).map_err(|e| AppError::from_io(e, "open vault"))?;
    if !meta.is_dir() {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "the vault path is not a folder",
        ));
    }
    fs::read_dir(&root).map_err(|e| AppError::from_io(e, "read vault folder"))?;
    let root_str = root
        .to_str()
        .ok_or_else(|| AppError::new(ErrorKind::InvalidPath, "the vault path is not valid UTF-8"))?
        .to_owned();
    let name = root
        .file_name()
        .and_then(OsStr::to_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let trimmed = root_str.trim_end_matches(['/', '\\']);
            if trimmed.is_empty() {
                root_str.clone()
            } else {
                trimmed.to_owned()
            }
        });

    let (epoch, previous) = state.activate(Root {
        path: root.clone(),
        mount_point: is_mount_point(&root, &meta) == Some(true),
    });
    drop(previous);

    if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
        log::warn!("asset scope for {root_str}: {e}");
    }

    // The watcher's file-ID cache walks the vault, so start it off this call; the
    // backend starts watching before that walk, and events queue meanwhile.
    let watch_app = app.clone();
    let watch_root = root.clone();
    let spawned = std::thread::Builder::new()
        .name("mininote-watcher-start".into())
        .spawn(
            move || match watcher::start(watch_app.clone(), &watch_root, epoch) {
                Ok(w) => {
                    if let Some(state) = watch_app.try_state::<VaultState>() {
                        state.install_watcher(epoch, w);
                    }
                }
                Err(e) => log::warn!("file watcher unavailable: {e}"),
            },
        );
    if let Err(e) = spawned {
        log::warn!("file watcher thread: {e}");
    }

    store::prune_recovery(app, &root);
    Ok(VaultInfo {
        root: root_str,
        name,
        epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_rel_accepts_plain_paths() {
        assert_eq!(split_rel("").unwrap(), Vec::<&str>::new());
        assert_eq!(split_rel("a.md").unwrap(), vec!["a.md"]);
        assert_eq!(
            split_rel("\u{B178}\u{D2B8}/\u{D68C}\u{C758} \u{BA54}\u{BAA8}.md").unwrap(),
            vec!["\u{B178}\u{D2B8}", "\u{D68C}\u{C758} \u{BA54}\u{BAA8}.md"]
        );
        // NFD Hangul stays byte-identical.
        let nfd = "\u{1102}\u{1169}\u{1110}\u{1173}.md";
        assert_eq!(split_rel(nfd).unwrap(), vec![nfd]);
        assert!(split_rel("folder/.hidden/x.md").is_ok());
        assert!(split_rel("a..b/c.md").is_ok());
    }

    #[test]
    fn split_rel_rejects_escapes() {
        for bad in [
            "/", "/a", "a/", "a//b", ".", "..", "./a", "a/.", "a/../b", "../a", "a/..", "a\0b",
            "\0",
        ] {
            let err = split_rel(bad).unwrap_err();
            assert_eq!(err.kind, ErrorKind::InvalidPath, "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_allows_backslash_and_colon() {
        assert!(split_rel("a\\b.md").is_ok());
        assert!(split_rel("10:30 standup.md").is_ok());
        assert!(split_rel("CON.md").is_ok());
        assert!(split_rel("trailing.").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_its_reserved_forms() {
        for bad in [
            "a\\b.md",
            "C:",
            "C:x.md",
            "a:b",
            "x?.md",
            "nul.md",
            "trailing.",
            "space ",
        ] {
            assert!(split_rel(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn windows_reserved_names() {
        for name in [
            "CON",
            "con.md",
            "Con .md",
            "aux.tar.md",
            "NUL",
            "COM1",
            "lpt9.txt",
            "COM0",
            "LPT¹",
            "CONIN$",
            "conout$.md",
        ] {
            assert!(is_windows_reserved(name), "{name}");
        }
        for name in [
            "CONSOLE.md",
            "COM10",
            "LPT",
            "nul2.md",
            "\u{B178}\u{D2B8}.md",
            "COMa",
        ] {
            assert!(!is_windows_reserved(name), "{name}");
        }
        assert!(!is_valid_windows_component("a<b"));
        assert!(!is_valid_windows_component("tab\there"));
        assert!(!is_valid_windows_component("dot."));
        assert!(is_valid_windows_component(
            "\u{D68C}\u{C758}\u{B85D} 2024.md"
        ));
    }

    #[test]
    fn to_rel_and_join_round_trip() {
        let root = std::env::temp_dir().join("mininote-root");
        let abs = join_rel(&root, "a/\u{B178}\u{D2B8}.md");
        assert_eq!(
            to_rel(&root, &abs).as_deref(),
            Some("a/\u{B178}\u{D2B8}.md")
        );
        assert_eq!(to_rel(&root, &root).as_deref(), Some(""));
        let sibling = std::env::temp_dir().join("mininote-root2").join("x.md");
        assert_eq!(to_rel(&root, &sibling), None);
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mininote-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_joins_inside_root() {
        let root = scratch_dir("resolve");
        fs::create_dir_all(root.join("real")).unwrap();
        assert_eq!(
            resolve(&root, "real/x.md").unwrap(),
            root.join("real").join("x.md")
        );
        assert_eq!(
            resolve(&root, "missing/deeper/x.md").unwrap(),
            root.join("missing").join("deeper").join("x.md")
        );
        assert_eq!(resolve(&root, "").unwrap(), root);
        assert_eq!(
            resolve(&root, "../x").unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_components() {
        let root = scratch_dir("symlink");
        let outside = scratch_dir("symlink-outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.join("f.md"), root.join("file-link.md")).unwrap();
        assert_eq!(
            resolve(&root, "linked/x.md").unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            resolve(&root, "linked").unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            resolve(&root, "file-link.md").unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
