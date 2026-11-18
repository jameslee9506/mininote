//! Each window's vault: state, epoch, the path guard, and `vault_open`, `vault_close`
//! and `vault_focus` (ARCHITECTURE §6.1, PLAT-08, VAULT-07). A folder is the vault of
//! one window at most.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::fs_ops::{LinkTargets, SelfWrites};
use crate::{store, watcher, windows};

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

/// One window's vault state, kept in [`Vaults`]. No lock is ever held across file I/O.
pub struct VaultState {
    /// Guarded together with `epoch`: both change under the write lock, and
    /// `root_for` reads both under the read lock, so a command can never pair an
    /// old epoch with a new root.
    root: RwLock<Option<Root>>,
    epoch: AtomicU64,
    watcher: Mutex<Option<watcher::VaultWatcher>>,
    registry: Mutex<SelfWrites>,
    /// The links the last listing found, by the file each leads to (TREE-18).
    links: Mutex<Arc<LinkTargets>>,
    /// Bumped by every search (and vault switch); a running search stops when it changes.
    pub search_gen: AtomicU64,
    /// Serializes this window's `vault_open` and `vault_close` calls.
    open_lock: Mutex<()>,
}

impl VaultState {
    pub(crate) fn new() -> Self {
        Self {
            root: RwLock::new(None),
            epoch: AtomicU64::new(0),
            watcher: Mutex::new(None),
            registry: Mutex::new(SelfWrites::default()),
            links: Mutex::new(Arc::default()),
            search_gen: AtomicU64::new(0),
            open_lock: Mutex::new(()),
        }
    }

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

    /// The links of the last listing, by the file each leads to: the watcher turns
    /// a change of such a file into a change of its links (§6.4).
    pub fn links(&self) -> Arc<LinkTargets> {
        lock(&self.links).clone()
    }

    /// Keeps the links a listing of the vault of `epoch` found. One taken for a
    /// vault that was replaced meanwhile is dropped.
    pub fn set_links(&self, epoch: u64, links: LinkTargets) {
        let mut slot = lock(&self.links);
        // `activate` stores the new epoch before it clears this slot.
        if self.epoch() == epoch {
            *slot = Arc::new(links);
        }
    }

    /// The open vault folder, if any.
    pub fn root_path(&self) -> Option<PathBuf> {
        let root = self.root.read().unwrap_or_else(PoisonError::into_inner);
        root.as_ref().map(|root| root.path.clone())
    }

    /// Makes `root` the active vault (`None`: no vault) under `epoch`: clears the
    /// registry and the links, cancels running searches and hands back the previous
    /// watcher for the caller to drop.
    fn activate(&self, root: Option<Root>, epoch: u64) -> Option<watcher::VaultWatcher> {
        let mut slot = lock(&self.watcher);
        {
            let mut current = self.root.write().unwrap_or_else(PoisonError::into_inner);
            *current = root;
            self.epoch.store(epoch, Ordering::SeqCst);
        }
        self.registry().clear();
        *lock(&self.links) = Arc::default();
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        slot.take()
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

    /// Stops the watcher (window closed, app exit).
    pub fn stop_watcher(&self) {
        let old = lock(&self.watcher).take();
        drop(old);
    }
}

/// Every window's [`VaultState`] by window label, managed by Tauri. Its lock also
/// makes taking a folder atomic: a folder is the vault of one window at most
/// (VAULT-07). Lock order: this map, then a state's own locks.
#[derive(Default)]
pub struct Vaults {
    windows: Mutex<HashMap<String, Arc<VaultState>>>,
    /// Source of every epoch, so that one never repeats in the process, whatever
    /// the window (a label can come back after its window closed).
    epochs: AtomicU64,
}

impl Vaults {
    /// Window `label`'s state, created on first use.
    pub fn of(&self, label: &str) -> Arc<VaultState> {
        lock(&self.windows)
            .entry(label.to_owned())
            .or_insert_with(|| Arc::new(VaultState::new()))
            .clone()
    }

    /// Window `label`'s state, if it has one.
    pub fn get(&self, label: &str) -> Option<Arc<VaultState>> {
        lock(&self.windows).get(label).cloned()
    }

    /// Forgets a closed window and stops its watcher. Work still running for it
    /// finishes against its own state, which nothing reaches any more.
    pub fn remove(&self, label: &str) {
        let state = lock(&self.windows).remove(label);
        if let Some(state) = state {
            state.stop_watcher();
        }
    }

    /// The window other than `except` whose vault is `root`.
    pub fn owner(&self, root: &Path, except: &str) -> Option<String> {
        owner_in(&lock(&self.windows), root, except)
    }

    /// Each open vault folder with its window's label.
    pub fn roots(&self) -> Vec<(String, PathBuf)> {
        lock(&self.windows)
            .iter()
            .filter_map(|(label, state)| state.root_path().map(|root| (label.clone(), root)))
            .collect()
    }

    /// Stops every watcher (app exit).
    pub fn stop_all(&self) {
        let states: Vec<_> = lock(&self.windows).values().cloned().collect();
        for state in states {
            state.stop_watcher();
        }
    }

    /// `state`, window `label`'s, takes `root` as its vault unless another window
    /// has it: the new epoch, and the previous watcher for the caller to drop.
    /// `Err` names the window that has the folder.
    fn claim(
        &self,
        label: &str,
        state: &VaultState,
        root: Root,
    ) -> Result<(u64, Option<watcher::VaultWatcher>), String> {
        let windows = lock(&self.windows);
        if let Some(owner) = owner_in(&windows, &root.path, label) {
            return Err(owner);
        }
        let epoch = self.epochs.fetch_add(1, Ordering::SeqCst) + 1;
        Ok((epoch, state.activate(Some(root), epoch)))
    }

    /// `state` has no vault any more: every request for the old one fails with
    /// `no_vault`, and another window may open the folder. Hands back its watcher.
    fn release(&self, state: &VaultState) -> Option<watcher::VaultWatcher> {
        let _claims = lock(&self.windows);
        let epoch = self.epochs.fetch_add(1, Ordering::SeqCst) + 1;
        state.activate(None, epoch)
    }
}

fn owner_in(
    windows: &HashMap<String, Arc<VaultState>>,
    root: &Path,
    except: &str,
) -> Option<String> {
    windows
        .iter()
        .find(|(label, state)| {
            label.as_str() != except && state.root_path().as_deref() == Some(root)
        })
        .map(|(label, _)| label.clone())
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

/// The vault state of the window a command came from.
pub fn state_of(window: &WebviewWindow) -> AppResult<Arc<VaultState>> {
    window
        .try_state::<Vaults>()
        .map(|vaults| vaults.of(window.label()))
        .ok_or_else(|| AppError::new(ErrorKind::Io, "vault state is not available"))
}

/// Runs blocking work on Tauri's blocking pool with the calling window's vault state.
pub async fn blocking<T, F>(window: &WebviewWindow, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&VaultState) -> AppResult<T> + Send + 'static,
{
    let state = state_of(window)?;
    background(move || work(&state)).await
}

/// Runs blocking work on Tauri's blocking pool.
pub async fn background<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
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
/// rejects it when it goes through a symlink or junction, that is when any existing
/// component before the last is one (one `symlink_metadata` per existing prefix).
/// A path can therefore never leave the vault through a linked folder.
///
/// The last component names an entry of a real folder of the vault, and that entry
/// may be a link. Commands act on the entry itself (rename, trash, delete, exists),
/// and an exclusive create fails on one. Only reading and writing a note follow it,
/// and only to a regular file (TREE-18).
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let parts = split_rel(rel)?;
    let folders = parts.len().saturating_sub(1);
    let mut path = root.to_path_buf();
    let mut probing = true;
    for (i, part) in parts.into_iter().enumerate() {
        path.push(part);
        if probing && i < folders {
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

/// The canonical form of an absolute folder path, the identity of a vault.
fn canonical_root(path: &str) -> AppResult<PathBuf> {
    if !Path::new(path).is_absolute() {
        return Err(AppError::new(
            ErrorKind::InvalidPath,
            "the vault path must be absolute",
        ));
    }
    dunce::canonicalize(path).map_err(|e| AppError::from_io(e, "open vault"))
}

/// Opens a folder as the calling window's vault (ARCHITECTURE §5): canonicalize,
/// require a readable directory, take it unless another window has it (that window
/// comes forward and this fails with `exists`), bump the epoch, allow the asset
/// scope, restart the watcher, prune old recovery copies.
#[tauri::command]
pub async fn vault_open(window: WebviewWindow, path: String) -> AppResult<VaultInfo> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let info = blocking(&window, move |state| open(&app, &label, state, &path)).await?;
    windows::remember_vaults(window.app_handle());
    Ok(info)
}

/// `vault_close`: the calling window shows no vault any more (the Welcome screen),
/// so its folder may open in another window. Called after the frontend flushed.
#[tauri::command]
pub async fn vault_close(window: WebviewWindow) -> AppResult<()> {
    let app = window.app_handle().clone();
    blocking(&window, move |state| {
        let _serial = lock(&state.open_lock);
        let watcher = app.state::<Vaults>().release(state);
        drop(watcher);
        Ok(())
    })
    .await?;
    windows::remember_vaults(window.app_handle());
    Ok(())
}

/// `vault_focus`: whether another window has the folder `path` open as its vault;
/// if so, that window comes forward (VAULT-07). A folder that cannot be resolved is
/// not open anywhere; `vault_open` reports what is wrong with it.
#[tauri::command]
pub async fn vault_focus(window: WebviewWindow, path: String) -> AppResult<bool> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    background(move || {
        let Ok(root) = canonical_root(&path) else {
            return Ok(false);
        };
        let owner = app.state::<Vaults>().owner(&root, &label);
        if let Some(owner) = &owner {
            windows::focus(&app, owner);
        }
        Ok(owner.is_some())
    })
    .await
}

fn open(app: &AppHandle, label: &str, state: &VaultState, path: &str) -> AppResult<VaultInfo> {
    let _serial = lock(&state.open_lock);
    let root = canonical_root(path)?;
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

    let claimed = app.state::<Vaults>().claim(
        label,
        state,
        Root {
            path: root.clone(),
            mount_point: is_mount_point(&root, &meta) == Some(true),
        },
    );
    let (epoch, previous) = match claimed {
        Ok(claimed) => claimed,
        Err(owner) => {
            windows::focus(app, &owner);
            return Err(AppError::new(
                ErrorKind::Exists,
                "the folder is open in another window",
            ));
        }
    };
    drop(previous);

    if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
        log::warn!("asset scope for {root_str}: {e}");
    }

    // The watcher's file-ID cache walks the vault, so start it off this call; the
    // backend starts watching before that walk, and events queue meanwhile.
    let watch_app = app.clone();
    let watch_root = root.clone();
    let watch_label = label.to_owned();
    let spawned = std::thread::Builder::new()
        .name("mininote-watcher-start".into())
        .spawn(move || {
            match watcher::start(watch_app.clone(), &watch_root, epoch, watch_label.clone()) {
                Ok(w) => {
                    let state = watch_app
                        .try_state::<Vaults>()
                        .and_then(|vaults| vaults.get(&watch_label));
                    if let Some(state) = state {
                        state.install_watcher(epoch, w);
                    }
                }
                Err(e) => log::warn!("file watcher unavailable: {e}"),
            }
        });
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
    fn resolve_never_goes_through_a_link() {
        let root = scratch_dir("symlink");
        let outside = scratch_dir("symlink-outside");
        fs::create_dir_all(outside.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.join("f.md"), root.join("file-link.md")).unwrap();
        for through in [
            "linked/x.md",
            "linked/sub",
            "linked/sub/x.md",
            "file-link.md/x",
        ] {
            assert_eq!(
                resolve(&root, through).unwrap_err().kind,
                ErrorKind::InvalidPath,
                "{through}"
            );
        }
        // A link is an entry of its folder: the path to it stays inside the vault.
        assert_eq!(resolve(&root, "linked").unwrap(), root.join("linked"));
        assert_eq!(
            resolve(&root, "file-link.md").unwrap(),
            root.join("file-link.md")
        );
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
