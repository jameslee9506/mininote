//! Vault file operations: listing, reading, atomic writes, create, rename, trash,
//! delete, reveal (ARCHITECTURE §6.2–6.3), plus the self-write registry the
//! watcher consults (SAVE-05).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::vault::{self, blocking, VaultState};

/// Notes larger than this are refused by `note_read` (SAVE-11).
pub const MAX_NOTE_BYTES: u64 = 20 * 1024 * 1024;
/// Listing cap (VAULT-01); `truncated` is set beyond it.
pub const MAX_ENTRIES: usize = 100_000;
/// Two mtimes closer than this (in ms) are equal: absorbs float rounding of the
/// baseline's round trip through JSON, far below any real write interval.
const MTIME_EPS_MS: f64 = 0.001;
/// Our temp files older than this are leftovers of a crash (SAVE-04).
const STALE_TEMP_AGE: Duration = Duration::from_secs(3600);
const REGISTRY_CAP: usize = 512;
/// Re-reads while a file keeps changing under `note_read` (SAVE-06 "partial files").
const READ_RETRIES: u32 = 3;
const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const NOTE_EXTS: [&str; 2] = ["md", "markdown"];
const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
/// Prefix and suffix of our atomic-write temp files: `.mn~<pid>-<n>.tmp`.
const TEMP_PREFIX: &str = ".mn~";
const TEMP_SUFFIX: &str = ".tmp";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------- DTOs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// `Entry` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub path: String,
    pub kind: EntryKind,
    pub mtime: f64,
    pub size: u64,
}

/// `ListResult` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct ListResult {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

/// `Baseline` / `WriteResult` in src/lib/types.ts: what a file looked like when
/// we last read or wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Baseline {
    pub mtime: f64,
    pub size: u64,
    pub hash: String,
}

/// `FileContent` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub bom: bool,
    pub read_only: bool,
    pub mtime: f64,
    pub size: u64,
    pub hash: String,
}

// ---------------------------------------------------------------- small helpers

/// FNV-1a 64-bit; stable across runs and platforms.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// FNV-1a as 16 lower-case hex characters (a `u64` does not fit a JS number).
pub fn hash_hex(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a(bytes))
}

/// Milliseconds since the Unix epoch.
pub fn system_time_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1_000_000.0,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

pub fn now_ms() -> f64 {
    system_time_ms(SystemTime::now())
}

pub fn mtime_ms(meta: &Metadata) -> f64 {
    meta.modified().map(system_time_ms).unwrap_or(0.0)
}

fn same_mtime(a: f64, b: f64) -> bool {
    (a - b).abs() < MTIME_EPS_MS
}

/// The mtime has no sub-second part (FAT, exFAT, HFS+, some SMB shares), so
/// size + mtime cannot tell two versions apart and the content hash decides.
fn is_coarse(meta: &Metadata) -> bool {
    match meta.modified().map(|t| t.duration_since(UNIX_EPOCH)) {
        Ok(Ok(d)) => d.subsec_nanos() == 0,
        _ => true,
    }
}

/// Not writable according to its metadata: no write bits (Unix), the read-only
/// attribute (Windows), or the immutable / append-only flags (macOS "locked").
pub fn is_read_only(meta: &Metadata) -> bool {
    if meta.permissions().readonly() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const UF_IMMUTABLE: u32 = 0x0000_0002;
        const UF_APPEND: u32 = 0x0000_0004;
        const SF_IMMUTABLE: u32 = 0x0002_0000;
        const SF_APPEND: u32 = 0x0004_0000;
        if meta.st_flags() & (UF_IMMUTABLE | UF_APPEND | SF_IMMUTABLE | SF_APPEND) != 0 {
            return true;
        }
    }
    false
}

/// The content is not on this machine (iCloud "Optimize Storage", OneDrive Files
/// On-Demand): reading would download it (SRCH-01).
pub fn is_cloud_placeholder(meta: &Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const OFFLINE: u32 = 0x0000_1000;
        const RECALL_ON_OPEN: u32 = 0x0004_0000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = meta;
        false
    }
}

/// Windows Hidden or System attribute (`$RECYCLE.BIN`, `desktop.ini`; TREE-01).
fn is_os_hidden(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        meta.file_attributes() & (HIDDEN | SYSTEM) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

pub fn is_hidden_name(name: &OsStr) -> bool {
    name.as_encoded_bytes().first() == Some(&b'.')
}

fn extension(name: &str) -> Option<String> {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => Some(ext.to_ascii_lowercase()),
        _ => None,
    }
}

/// A note (`.md`, `.markdown`, any case).
pub fn is_note_name(name: &str) -> bool {
    extension(name).is_some_and(|e| NOTE_EXTS.contains(&e.as_str()))
}

/// A file the tree lists: a note or an image.
pub fn is_listed_file_name(name: &str) -> bool {
    extension(name)
        .is_some_and(|e| NOTE_EXTS.contains(&e.as_str()) || IMAGE_EXTS.contains(&e.as_str()))
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::InvalidPath, message)
}

fn not_found(rel: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("not found: {rel}"))
}

fn conflict(rel: &str) -> AppError {
    AppError::new(ErrorKind::Conflict, format!("changed on disk: {rel}"))
}

fn is_denied(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
    )
}

/// The one writability test, shared by `note_read` and `note_write` so a note
/// never opens editable only to fail its first save (SAVE-08): [`is_read_only`]
/// metadata, or a refused write-open, which also catches ownership, ACLs and
/// read-only mounts or shares that the mode bits and attributes do not show. The
/// probe neither creates nor truncates; a sharing violation (the file is merely
/// held open elsewhere) is not a refusal.
fn not_writable(abs: &Path, meta: &Metadata) -> bool {
    is_read_only(meta)
        || OpenOptions::new()
            .write(true)
            .open(abs)
            .is_err_and(|e| is_denied(&e))
}

/// Same device and inode on Unix. std has no stable file identity elsewhere, so
/// there this is always true.
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (a.dev(), a.ino()) == (b.dev(), b.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        true
    }
}

/// `a` and `b` describe the same version of the same file: both regular files
/// with the same size and mtime, and the same inode on Unix.
fn same_version(a: &Metadata, b: &Metadata) -> bool {
    a.is_file()
        && b.is_file()
        && same_inode(a, b)
        && a.len() == b.len()
        && same_mtime(mtime_ms(a), mtime_ms(b))
}

fn lstat(path: &Path, rel: &str) -> AppResult<Metadata> {
    fs::symlink_metadata(path).map_err(|e| AppError::from_io(e, rel))
}

/// The longest prefix of `s` that fits `max` bytes, cut at a character boundary.
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ---------------------------------------------------------------- self-write registry

/// What we last did to a path, so the watcher can drop our own echoes (SAVE-05).
#[derive(Debug, Clone)]
pub struct Record {
    pub size: u64,
    pub mtime: f64,
    /// Content hash of our write; `None` for rename records (content not read).
    pub hash: Option<String>,
    /// The path is the source of one of our renames (its `remove` is an echo).
    /// The watcher honors this only for a few seconds after `at`, so the record
    /// never swallows a later, real delete of that path.
    pub moved_away: bool,
    /// When the record was made.
    pub at: Instant,
}

/// Bounded map from absolute path to its latest [`Record`]; the oldest record is
/// evicted first.
#[derive(Debug, Default)]
pub struct SelfWrites {
    entries: HashMap<PathBuf, (u64, Record)>,
    seq: u64,
}

impl SelfWrites {
    pub fn insert(&mut self, path: PathBuf, record: Record) {
        self.seq += 1;
        self.entries.insert(path, (self.seq, record));
        if self.entries.len() > REGISTRY_CAP {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, (seq, _))| *seq)
                .map(|(p, _)| p.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
    }

    pub fn get(&self, path: &Path) -> Option<Record> {
        self.entries.get(path).map(|(_, record)| record.clone())
    }

    /// Forgets `path`. Called when we create it, so an older record (above all
    /// the source of an earlier rename) never applies to the new entry.
    pub fn remove(&mut self, path: &Path) {
        self.entries.remove(path);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.seq = 0;
    }
}

/// Whether `meta` still describes our recorded state: same size and mtime, and,
/// when the mtime is coarse, the same content hash (never assumed for records
/// without a hash, so a same-tick external edit is not swallowed).
pub fn matches_record(path: &Path, meta: &Metadata, record: &Record) -> bool {
    if !matches_size_mtime(meta, record) {
        return false;
    }
    if !is_coarse(meta) {
        return true;
    }
    match &record.hash {
        Some(hash) => meta.is_file() && fs::read(path).is_ok_and(|bytes| &hash_hex(&bytes) == hash),
        None => false,
    }
}

/// Same size and mtime as recorded.
pub fn matches_size_mtime(meta: &Metadata, record: &Record) -> bool {
    meta.len() == record.size && same_mtime(mtime_ms(meta), record.mtime)
}

/// Records a rename (and an optional intermediate temp) so its echoes are dropped.
fn record_move(state: &VaultState, from: &Path, to: &Path, temp: Option<&Path>) {
    let Ok(meta) = fs::symlink_metadata(to) else {
        return;
    };
    let at = Instant::now();
    let record = |moved_away| Record {
        size: meta.len(),
        mtime: mtime_ms(&meta),
        hash: None,
        moved_away,
        at,
    };
    let mut registry = state.registry();
    registry.insert(to.to_path_buf(), record(false));
    registry.insert(from.to_path_buf(), record(true));
    if let Some(temp) = temp {
        registry.insert(temp.to_path_buf(), record(true));
    }
}

// ---------------------------------------------------------------- walking

/// One entry `vault_list` shows.
pub struct Walked {
    pub path: PathBuf,
    pub rel: String,
    pub is_dir: bool,
    pub meta: Metadata,
}

/// Walks the vault with the listing rules (TREE-01): no names starting with `.`,
/// no symlinks or junctions (never followed), no Windows Hidden/System entries,
/// no names that are not UTF-8; folders, notes and images only. An unreadable
/// sub-folder is listed without children. `visit` returns `false` to stop.
/// When `stale` is given, our leftover temp files (older than an hour) are
/// collected into it.
pub fn walk_vault(
    root: &Path,
    mut stale: Option<&mut Vec<PathBuf>>,
    mut visit: impl FnMut(Walked) -> bool,
) {
    let mut entries = walkdir::WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .into_iter();
    while let Some(next) = entries.next() {
        let Ok(entry) = next else { continue };
        let file_type = entry.file_type();
        let is_dir = file_type.is_dir();
        if is_hidden_name(entry.file_name()) {
            if is_dir {
                entries.skip_current_dir();
            } else if let Some(list) = stale.as_deref_mut() {
                if file_type.is_file() && is_stale_temp(&entry) {
                    list.push(entry.into_path());
                }
            }
            continue;
        }
        if file_type.is_symlink() || !(is_dir || file_type.is_file()) {
            continue;
        }
        if !is_dir && !entry.file_name().to_str().is_some_and(is_listed_file_name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) if !is_os_hidden(&meta) => meta,
            _ => {
                if is_dir {
                    entries.skip_current_dir();
                }
                continue;
            }
        };
        let Some(rel) = vault::to_rel(root, entry.path()) else {
            if is_dir {
                entries.skip_current_dir();
            }
            continue;
        };
        if !visit(Walked {
            path: entry.into_path(),
            rel,
            is_dir,
            meta,
        }) {
            return;
        }
    }
}

fn is_stale_temp(entry: &walkdir::DirEntry) -> bool {
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    if !(name.starts_with(TEMP_PREFIX) && name.ends_with(TEMP_SUFFIX)) {
        return false;
    }
    entry
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > STALE_TEMP_AGE)
}

/// `vault_list` (scoped): flat metadata-only listing (ARCHITECTURE §6.3).
#[tauri::command]
pub async fn vault_list(app: AppHandle, epoch: u64) -> AppResult<ListResult> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        list_vault(&root)
    })
    .await
}

fn list_vault(root: &Path) -> AppResult<ListResult> {
    fs::read_dir(root).map_err(|e| {
        AppError::new(
            ErrorKind::RootUnavailable,
            format!("vault folder unreadable: {e}"),
        )
    })?;
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut stale = Vec::new();
    walk_vault(root, Some(&mut stale), |w| {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            return false;
        }
        entries.push(Entry {
            path: w.rel,
            kind: if w.is_dir {
                EntryKind::Dir
            } else {
                EntryKind::File
            },
            mtime: mtime_ms(&w.meta),
            size: if w.is_dir { 0 } else { w.meta.len() },
        });
        true
    });
    for path in stale {
        let _ = fs::remove_file(path);
    }
    Ok(ListResult { entries, truncated })
}

// ---------------------------------------------------------------- reading

/// `note_read` (scoped): UTF-8 text with the BOM stripped, plus `readOnly` and the
/// baseline. A file that changes while being read is read again.
#[tauri::command]
pub async fn note_read(app: AppHandle, epoch: u64, path: String) -> AppResult<FileContent> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &path)?;
        read_note(&abs, &path)
    })
    .await
}

fn stat_note(abs: &Path, rel: &str) -> AppResult<Metadata> {
    let meta = lstat(abs, rel)?;
    if !meta.is_file() {
        return Err(invalid(format!("not a file: {rel}")));
    }
    if meta.len() > MAX_NOTE_BYTES {
        return Err(AppError::new(
            ErrorKind::TooLarge,
            format!("larger than 20 MB: {rel}"),
        ));
    }
    Ok(meta)
}

fn read_note(abs: &Path, rel: &str) -> AppResult<FileContent> {
    let mut attempt = 0;
    loop {
        let before = stat_note(abs, rel)?;
        let bytes = fs::read(abs).map_err(|e| AppError::from_io(e, rel))?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err(AppError::new(
                ErrorKind::TooLarge,
                format!("larger than 20 MB: {rel}"),
            ));
        }
        let after = lstat(abs, rel)?;
        let settled = before.len() == after.len()
            && same_mtime(mtime_ms(&before), mtime_ms(&after))
            && bytes.len() as u64 == after.len();
        if settled || attempt >= READ_RETRIES {
            // An unsettled read keeps the pre-read baseline: any later change then
            // fails the save-time check instead of being overwritten.
            return decode_note(bytes, &before, not_writable(abs, &after), rel);
        }
        attempt += 1;
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn decode_note(
    mut bytes: Vec<u8>,
    baseline: &Metadata,
    read_only: bool,
    rel: &str,
) -> AppResult<FileContent> {
    let hash = hash_hex(&bytes);
    let bom = bytes.starts_with(&BOM);
    if bom {
        bytes.drain(..BOM.len());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| AppError::new(ErrorKind::NotUtf8, format!("not UTF-8: {rel}")))?;
    Ok(FileContent {
        content,
        bom,
        read_only,
        mtime: mtime_ms(baseline),
        size: baseline.len(),
        hash,
    })
}

// ---------------------------------------------------------------- raw-body requests

fn header_str<'a>(request: &'a Request<'_>, name: &str) -> AppResult<Option<&'a str>> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(value) => value
            .to_str()
            .map(|s| Some(s.trim()))
            .map_err(|_| AppError::new(ErrorKind::Io, format!("malformed {name} header"))),
    }
}

fn header_epoch(request: &Request<'_>) -> AppResult<u64> {
    header_str(request, "x-epoch")
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| AppError::new(ErrorKind::NoVault, "missing vault epoch"))
}

/// `x-path`: the URI-encoded `VaultPath` (absent or empty means the root).
fn header_path(request: &Request<'_>) -> AppResult<String> {
    let raw = header_str(request, "x-path")?.unwrap_or("");
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| invalid("x-path is not valid UTF-8"))
}

/// `x-expected`: the JSON baseline, or empty (absent) for an unconditional write.
fn header_expected(request: &Request<'_>) -> AppResult<Option<Baseline>> {
    match header_str(request, "x-expected")? {
        None | Some("") => Ok(None),
        Some(json) => serde_json::from_str(json)
            .map(Some)
            .map_err(|e| AppError::new(ErrorKind::Io, format!("malformed x-expected header: {e}"))),
    }
}

/// The raw body. The postMessage IPC fallback delivers it as a JSON array of
/// bytes; anything else is refused, so a missing body never empties a file.
fn body_bytes(request: &Request<'_>) -> AppResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(value @ serde_json::Value::Array(_)) => {
            serde_json::from_value(value.clone())
                .map_err(|e| AppError::new(ErrorKind::Io, format!("malformed request body: {e}")))
        }
        InvokeBody::Json(_) => Err(AppError::new(ErrorKind::Io, "missing request body")),
    }
}

// ---------------------------------------------------------------- writing

/// Creates the missing folders between the root and `abs`'s parent, one level at
/// a time, never the root itself (VAULT-06): with the root gone the first
/// `create_dir` fails instead of rebuilding an unmounted volume's path.
fn ensure_parent_dirs(root: &Path, abs: &Path) -> AppResult<()> {
    let parent = abs.parent().ok_or_else(|| invalid("no parent folder"))?;
    let rest = parent
        .strip_prefix(root)
        .map_err(|_| invalid("outside the vault"))?;
    let mut current = root.to_path_buf();
    for part in rest.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(invalid("path goes through a symlink"))
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(AppError::new(
                    ErrorKind::Exists,
                    "a file is in the way of the folder",
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::create_dir(&current) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && current.is_dir() => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound && !root.is_dir() => {
                    return Err(AppError::new(
                        ErrorKind::RootUnavailable,
                        "the vault folder is not available",
                    ));
                }
                Err(e) => return Err(AppError::from_write(e, "create folder")),
            },
            Err(e) => return Err(AppError::from_io(e, "create folder")),
        }
    }
    Ok(())
}

/// fsyncs a folder so a rename or create in it survives power loss (Linux and BSD;
/// macOS `sync_all` already issues a full flush).
fn sync_dir(dir: &Path) {
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    let _ = dir;
}

/// `fs::rename`, retried on Windows sharing/permission errors (raw OS errors 5, 32,
/// 33) after 10, 20, 40, 80 and 160 ms: Defender, OneDrive or our own watcher may
/// hold the file for a moment.
pub fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    rename_guarded(from, to, &|| Ok(()), |e| e)
}

/// [`rename_retry`] that runs `guard` right before every attempt, Windows retries
/// included, and stops with its error (nothing moved) as soon as it fails: the
/// checks a rename was decided on still hold when it happens, not only before
/// the slow work that precedes it. I/O errors go through `io_err`.
fn rename_guarded<E>(
    from: &Path,
    to: &Path,
    guard: &dyn Fn() -> Result<(), E>,
    io_err: impl Fn(io::Error) -> E,
) -> Result<(), E> {
    #[cfg(windows)]
    {
        let mut delays = [10u64, 20, 40, 80, 160].into_iter();
        loop {
            guard()?;
            match fs::rename(from, to) {
                Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) => match delays.next() {
                    Some(ms) => std::thread::sleep(Duration::from_millis(ms)),
                    None => return Err(io_err(e)),
                },
                result => return result.map_err(&io_err),
            }
        }
    }
    #[cfg(not(windows))]
    {
        guard()?;
        fs::rename(from, to).map_err(io_err)
    }
}

/// Creates `.mn~<pid>-<n>.tmp` in `dir`. The name never embeds the note's name, so
/// a note near the 255-byte limit still saves (SAVE-04).
fn create_temp(dir: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..32 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(
            "{TEMP_PREFIX}{}-{n}{TEMP_SUFFIX}",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free temporary file name",
    ))
}

/// Gives the temp file the original's group and owner (Unix), permissions
/// (before any content lands in it) and creation time, writes the bytes and
/// flushes them to disk. Copying the metadata is best effort: FAT mounts and some
/// SMB shares refuse `chmod`, only root may give a file away, and none of that
/// must make every save fail.
fn fill_temp(mut file: File, bytes: &[u8], original: Option<&Metadata>) -> io::Result<()> {
    if let Some(original) = original {
        #[cfg(unix)]
        {
            // The owner first: a chown may clear the set-id bits the mode restores.
            copy_owner(&file, original);
            let _ = file.set_permissions(original.permissions());
        }
        copy_creation_time(&file, original);
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Keeps the original's group, and its owner where allowed (as root, or the same
/// user), so a save in a shared, group-writable folder does not hand the note to
/// the saver's own group and lock its owner out (SAVE-04). Best effort.
#[cfg(unix)]
fn copy_owner(file: &File, original: &Metadata) {
    use std::os::unix::fs::{fchown, MetadataExt};
    let Ok(own) = file.metadata() else { return };
    if own.gid() != original.gid() {
        // Allowed for any group the saving user belongs to.
        let _ = fchown(file, None, Some(original.gid()));
    }
    if own.uid() != original.uid() {
        // Allowed only as root.
        let _ = fchown(file, Some(original.uid()), None);
    }
}

/// Keeps a note's "created" date across saves (SAVE-04); best effort.
fn copy_creation_time(file: &File, original: &Metadata) {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::FileTimesExt;
        if let Ok(created) = original.created() {
            let _ = file.set_times(fs::FileTimes::new().set_created(created));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTimesExt;
        if let Ok(created) = original.created() {
            let _ = file.set_times(fs::FileTimes::new().set_created(created));
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (file, original);
}

/// Replaces (or creates) `target` atomically: temp file in the same folder,
/// fsync, rename. `original` is the existing target's metadata. With
/// `in_place_fallback`, a folder that refuses the temp file gets an in-place
/// write of the (writable) target instead (SAVE-04). `verify` runs right before
/// the target is replaced (before every rename attempt, and before an in-place
/// write), and its error aborts the write. On failure the temp file is removed
/// and the target is untouched.
///
/// Returns the temp file's metadata from just before it replaced the target:
/// what the target holds now, unless something replaced it since. `None` after
/// an in-place write.
pub fn write_atomic(
    target: &Path,
    bytes: &[u8],
    original: Option<&Metadata>,
    in_place_fallback: bool,
    verify: Option<&dyn Fn() -> AppResult<()>>,
) -> AppResult<Option<Metadata>> {
    let check = || verify.map_or(Ok(()), |verify| verify());
    let dir = target.parent().ok_or_else(|| invalid("no parent folder"))?;
    let (temp, file) = match create_temp(dir) {
        Ok(created) => created,
        Err(e) if is_denied(&e) && in_place_fallback && original.is_some() => {
            check()?;
            write_in_place(target, bytes)?;
            return Ok(None);
        }
        Err(e) => return Err(AppError::from_write(e, "create temporary file")),
    };
    if let Err(e) = fill_temp(file, bytes, original) {
        let _ = fs::remove_file(&temp);
        return Err(AppError::from_io(e, "write temporary file"));
    }
    let written = fs::symlink_metadata(&temp).ok();
    if let Err(e) = rename_guarded(&temp, target, &check, |e| {
        AppError::from_io(e, "replace file")
    }) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    sync_dir(dir);
    Ok(written)
}

/// Not atomic; only for folders that refuse new files while the file itself is writable.
fn write_in_place(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(target)
        .map_err(|e| AppError::from_write(e, "open file for writing"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| AppError::from_io(e, "write file in place"))
}

/// Exclusive create of a new file with `bytes` (never overwrites). A partially
/// written file is removed again on failure.
fn create_exclusive(abs: &Path, bytes: &[u8], rel: &str) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(abs)
        .map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                AppError::new(ErrorKind::Exists, format!("already exists: {rel}"))
            } else {
                AppError::from_write(e, rel)
            }
        })?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(abs);
        return Err(AppError::from_io(e, rel));
    }
    if let Some(dir) = abs.parent() {
        sync_dir(dir);
    }
    Ok(())
}

/// Refuses targets that cannot be written: never replace a protected file
/// (SAVE-04). Uses the same test as `note_read`'s `readOnly` ([`not_writable`]).
fn ensure_writable(abs: &Path, meta: &Metadata, rel: &str) -> AppResult<()> {
    if not_writable(abs, meta) {
        return Err(AppError::new(
            ErrorKind::ReadOnly,
            format!("read-only: {rel}"),
        ));
    }
    Ok(())
}

/// The target is still what `write_note` examined: still absent when `current` is
/// `None`, otherwise the same file version and, when the mtime is coarse and a
/// baseline was given, still the expected content. `conflict` when it changed,
/// `not_found` when it vanished.
fn ensure_unchanged(
    abs: &Path,
    rel: &str,
    current: Option<&Metadata>,
    expected: Option<&Baseline>,
) -> AppResult<()> {
    let now = match fs::symlink_metadata(abs) {
        Ok(now) => Some(now),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            None
        }
        Err(e) => return Err(AppError::from_io(e, rel)),
    };
    let now = match (current, now) {
        (None, None) => return Ok(()),
        (Some(_), None) => return Err(not_found(rel)),
        (Some(before), Some(now)) if same_version(before, &now) => now,
        _ => return Err(conflict(rel)),
    };
    if let Some(expected) = expected {
        if is_coarse(&now) {
            let disk = fs::read(abs).map_err(|e| AppError::from_io(e, rel))?;
            if hash_hex(&disk) != expected.hash {
                return Err(conflict(rel));
            }
        }
    }
    Ok(())
}

/// `note_write` (scoped, raw body): atomic write with the save-time conflict check
/// (ARCHITECTURE §6.2).
#[tauri::command]
pub async fn note_write(app: AppHandle, request: Request<'_>) -> AppResult<Baseline> {
    let epoch = header_epoch(&request)?;
    let rel = header_path(&request)?;
    let expected = header_expected(&request)?;
    let bytes = body_bytes(&request)?;
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &rel)?;
        write_note(state, &root, &abs, &rel, &bytes, expected.as_ref())
    })
    .await
}

fn write_note(
    state: &VaultState,
    root: &Path,
    abs: &Path,
    rel: &str,
    bytes: &[u8],
    expected: Option<&Baseline>,
) -> AppResult<Baseline> {
    if rel.is_empty() {
        return Err(invalid("cannot write the vault folder"));
    }
    let current = match fs::symlink_metadata(abs) {
        Ok(meta) if meta.is_file() => Some(meta),
        Ok(_) => return Err(invalid(format!("not a file: {rel}"))),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            None
        }
        Err(e) => return Err(AppError::from_io(e, rel)),
    };
    if let Some(expected) = expected {
        let meta = current.as_ref().ok_or_else(|| not_found(rel))?;
        if meta.len() != expected.size || !same_mtime(mtime_ms(meta), expected.mtime) {
            return Err(conflict(rel));
        }
        if is_coarse(meta) {
            let disk = fs::read(abs).map_err(|e| AppError::from_io(e, rel))?;
            if hash_hex(&disk) != expected.hash {
                return Err(conflict(rel));
            }
        }
    }
    match &current {
        Some(meta) => ensure_writable(abs, meta, rel)?,
        None => ensure_parent_dirs(root, abs)?,
    }
    // The checks above ran before the temp file was written and flushed (tens of
    // ms, more on network drives). Repeated right before the target is replaced,
    // they turn an external write that landed meanwhile into a conflict, instead
    // of overwriting it and then mistaking it for our own echo.
    let unchanged = || ensure_unchanged(abs, rel, current.as_ref(), expected);
    let written = write_atomic(abs, bytes, current.as_ref(), true, Some(&unchanged))?;
    let on_disk = lstat(abs, rel)?;
    // Another program may have replaced our file right after the rename. Then the
    // baseline describes our version, so the next save's check and the watcher
    // see theirs as a change, and nothing is recorded for it. The mtime is not
    // compared: a network share may report the server's write time only once the
    // rename refreshed its cache. A false alarm (a filesystem that derives inode
    // numbers from the name) only costs the echo suppression of this one save.
    let (meta, ours) = match written {
        Some(written)
            if !(on_disk.is_file()
                && on_disk.len() == written.len()
                && same_inode(&on_disk, &written)) =>
        {
            (written, false)
        }
        _ => (on_disk, true),
    };
    let baseline = Baseline {
        mtime: mtime_ms(&meta),
        size: meta.len(),
        hash: hash_hex(bytes),
    };
    let mut registry = state.registry();
    if current.is_some() && ours {
        registry.insert(
            abs.to_path_buf(),
            Record {
                size: baseline.size,
                mtime: baseline.mtime,
                hash: Some(baseline.hash.clone()),
                moved_away: false,
                at: Instant::now(),
            },
        );
    } else {
        // Only overwrites that are still ours are recorded: the `create` echo of
        // a write that made a new file must reach the frontend, whose tree does
        // not know the file yet, and an older record must not cover either case.
        registry.remove(abs);
    }
    Ok(baseline)
}

/// `note_create` (scoped): exclusive create of a new note (missing parents inside
/// the root are created). Used for new notes and conflict copies.
#[tauri::command]
pub async fn note_create(
    app: AppHandle,
    epoch: u64,
    path: String,
    content: String,
) -> AppResult<Baseline> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &path)?;
        if path.is_empty() {
            return Err(AppError::new(ErrorKind::Exists, "the vault folder exists"));
        }
        ensure_parent_dirs(&root, &abs)?;
        let bytes = content.as_bytes();
        create_exclusive(&abs, bytes, &path)?;
        state.registry().remove(&abs);
        let meta = lstat(&abs, &path)?;
        Ok(Baseline {
            mtime: mtime_ms(&meta),
            size: meta.len(),
            hash: hash_hex(bytes),
        })
    })
    .await
}

/// `binary_write` (scoped, raw body): a new file only (pasted or dropped images).
#[tauri::command]
pub async fn binary_write(app: AppHandle, request: Request<'_>) -> AppResult<()> {
    let epoch = header_epoch(&request)?;
    let rel = header_path(&request)?;
    let bytes = body_bytes(&request)?;
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &rel)?;
        if rel.is_empty() {
            return Err(AppError::new(ErrorKind::Exists, "the vault folder exists"));
        }
        ensure_parent_dirs(&root, &abs)?;
        create_exclusive(&abs, &bytes, &rel)?;
        state.registry().remove(&abs);
        Ok(())
    })
    .await
}

/// `dir_create` (scoped): creates a folder and its missing parents.
#[tauri::command]
pub async fn dir_create(app: AppHandle, epoch: u64, path: String) -> AppResult<()> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &path)?;
        if path.is_empty() || fs::symlink_metadata(&abs).is_ok() {
            return Err(AppError::new(
                ErrorKind::Exists,
                format!("already exists: {path}"),
            ));
        }
        ensure_parent_dirs(&root, &abs)?;
        fs::create_dir(&abs).map_err(|e| AppError::from_write(e, &path))?;
        state.registry().remove(&abs);
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------- rename

/// `path_rename` (scoped): files and folders; `to`'s parent is created. Refuses
/// the root, a folder into itself, and taken targets, except a case- or
/// normalization-only rename of the same entry.
#[tauri::command]
pub async fn path_rename(app: AppHandle, epoch: u64, from: String, to: String) -> AppResult<()> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        rename_entry(state, &root, &from, &to)
    })
    .await
}

fn rename_entry(state: &VaultState, root: &Path, from_rel: &str, to_rel: &str) -> AppResult<()> {
    if from_rel.is_empty() || to_rel.is_empty() {
        return Err(invalid("the vault folder cannot be renamed"));
    }
    if from_rel == to_rel {
        return Ok(());
    }
    if to_rel
        .strip_prefix(from_rel)
        .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err(invalid("a folder cannot move into itself"));
    }
    let from = vault::resolve(root, from_rel)?;
    let to = vault::resolve(root, to_rel)?;
    let from_meta = lstat(&from, from_rel)?;
    let map_err = |e: io::Error| match e.kind() {
        io::ErrorKind::InvalidInput => invalid("a folder cannot move into itself"),
        io::ErrorKind::CrossesDevices => AppError::new(ErrorKind::Io, "cannot move across volumes"),
        _ => AppError::from_io(e, "rename"),
    };
    let taken = || AppError::new(ErrorKind::Exists, format!("already exists: {to_rel}"));
    let missing = |e: &io::Error| {
        matches!(
            e.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
        )
    };
    let temp = match fs::symlink_metadata(&to) {
        Ok(to_meta) => {
            if !same_entry(&from, &from_meta, &to, &to_meta) || !names_fold_equal(&from, &to) {
                return Err(taken());
            }
            rename_same_entry(&from, &to).map_err(map_err)?
        }
        Err(e) if missing(&e) => {
            ensure_parent_dirs(root, &to)?;
            // A rename replaces whatever is at `to`, so check again right before
            // every attempt (folders may just have been created, and Windows may
            // retry for 310 ms): a file that appeared meanwhile is `exists`.
            let still_free = || match fs::symlink_metadata(&to) {
                Ok(_) => Err(taken()),
                Err(e) if missing(&e) => Ok(()),
                Err(e) => Err(AppError::from_io(e, to_rel)),
            };
            rename_guarded(&from, &to, &still_free, map_err)?;
            None
        }
        Err(e) => return Err(AppError::from_io(e, to_rel)),
    };
    if let Some(dir) = to.parent() {
        sync_dir(dir);
    }
    record_move(state, &from, &to, temp.as_deref());
    Ok(())
}

/// Same file by identity: device and inode on Unix; on Windows the canonical
/// path, which reads the stored name back through the handle (PLAT-07).
fn same_entry(from: &Path, from_meta: &Metadata, to: &Path, to_meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = (from, to);
        from_meta.dev() == to_meta.dev() && from_meta.ino() == to_meta.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (from_meta, to_meta);
        matches!((fs::canonicalize(from), fs::canonicalize(to)), (Ok(a), Ok(b)) if a == b)
    }
}

/// The two last components differ only in case or Unicode normalization (a hard
/// link under another name is not a case rename).
fn names_fold_equal(a: &Path, b: &Path) -> bool {
    let fold = |p: &Path| -> Option<String> {
        Some(
            p.file_name()?
                .to_str()?
                .nfc()
                .flat_map(char::to_lowercase)
                .collect(),
        )
    };
    matches!((fold(a), fold(b)), (Some(x), Some(y)) if x == y)
}

/// Case/normalization-only rename. The direct rename is tried first (APFS, HFS+,
/// NTFS accept it) and the stored name read back; only when it did not change
/// (FAT/exFAT on Linux treat it as a no-op) does it go through a visible temp
/// name that keeps the extension, rolling back if the second step fails.
/// Returns the temp path when one was used.
fn rename_same_entry(from: &Path, to: &Path) -> io::Result<Option<PathBuf>> {
    rename_retry(from, to)?;
    if stored_name_is(to) {
        return Ok(None);
    }
    let temp = case_rename_temp(from)?;
    rename_retry(from, &temp)?;
    if let Err(e) = rename_retry(&temp, to) {
        let _ = rename_retry(&temp, from);
        return Err(e);
    }
    Ok(Some(temp))
}

/// The parent folder lists `path`'s last component byte-for-byte.
fn stored_name_is(path: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    fs::read_dir(parent).is_ok_and(|mut list| list.any(|e| e.is_ok_and(|e| e.file_name() == name)))
}

/// `<stem>.mn-tmp-<n>.<ext>` next to `from`: listed by the tree, so a crash
/// between the two steps leaves a visible note (PLAT-07), and within 255 bytes.
fn case_rename_temp(from: &Path) -> io::Result<PathBuf> {
    let not_utf8 = || io::Error::new(io::ErrorKind::InvalidInput, "name is not valid UTF-8");
    let parent = from.parent().ok_or_else(not_utf8)?;
    let name = from
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(not_utf8)?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (name, None),
    };
    for _ in 0..32 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let suffix = match ext {
            Some(ext) => format!(".mn-tmp-{n}.{ext}"),
            None => format!(".mn-tmp-{n}"),
        };
        let mut short = truncate_utf8(stem, 255usize.saturating_sub(suffix.len()));
        if short.is_empty() {
            short = "note";
        }
        let candidate = parent.join(format!("{short}{suffix}"));
        if fs::symlink_metadata(&candidate).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free temporary name",
    ))
}

// ---------------------------------------------------------------- trash, delete, exists, reveal

/// `path_trash` (scoped): moves to the OS trash; `trash_failed` when unsupported.
#[tauri::command]
pub async fn path_trash(app: AppHandle, epoch: u64, path: String) -> AppResult<()> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        if path.is_empty() {
            return Err(invalid("the vault folder cannot be deleted"));
        }
        let abs = vault::resolve(&root, &path)?;
        lstat(&abs, &path)?;
        #[allow(unused_mut)]
        let mut trash = trash::TrashContext::default();
        #[cfg(target_os = "macos")]
        {
            // The default method drives Finder through AppleScript and can raise
            // an Automation permission prompt (TREE-08).
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            trash.set_delete_method(DeleteMethod::NsFileManager);
        }
        trash
            .delete(&abs)
            .map_err(|e| AppError::new(ErrorKind::TrashFailed, format!("{path}: {e}")))
    })
    .await
}

/// `path_delete` (scoped): permanent, recursive; only after confirmation.
#[tauri::command]
pub async fn path_delete(app: AppHandle, epoch: u64, path: String) -> AppResult<()> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        if path.is_empty() {
            return Err(invalid("the vault folder cannot be deleted"));
        }
        let abs = vault::resolve(&root, &path)?;
        let meta = lstat(&abs, &path)?;
        let removed = if meta.is_dir() {
            fs::remove_dir_all(&abs)
        } else {
            fs::remove_file(&abs)
        };
        removed.map_err(|e| AppError::from_io(e, &path))
    })
    .await
}

/// `path_exists` (scoped).
#[tauri::command]
pub async fn path_exists(app: AppHandle, epoch: u64, path: String) -> AppResult<bool> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &path)?;
        match fs::symlink_metadata(&abs) {
            Ok(_) => Ok(true),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(false)
            }
            Err(e) => Err(AppError::from_io(e, &path)),
        }
    })
    .await
}

/// `path_reveal` (scoped): selects the item in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn path_reveal(app: AppHandle, epoch: u64, path: String) -> AppResult<()> {
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let abs = vault::resolve(&root, &path)?;
        lstat(&abs, &path)?;
        tauri_plugin_opener::reveal_item_in_dir(&abs)
            .map_err(|e| AppError::new(ErrorKind::Io, format!("reveal {path}: {e}")))
    })
    .await
}
