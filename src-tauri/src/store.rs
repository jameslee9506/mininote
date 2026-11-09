//! Settings JSON and recovery copies, kept in the OS app folders, never in the
//! vault (ARCHITECTURE §5, SET-01, SAVE-10, VAULT-04).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::fs_ops::{self, Baseline};
use crate::vault::{self, blocking, lock};

const SETTINGS_FILE: &str = "settings.json";
const RECOVERY_DIR: &str = "recovery";
/// Recovery copies whose note is gone are pruned after this long (SAVE-10).
const RECOVERY_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Serializes settings writes, including the corrupt-file check before each one.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// `RecoveryCopy` in src/lib/types.ts; also the on-disk format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCopy {
    pub path: String,
    pub content: String,
    pub baseline: Option<Baseline>,
    pub saved_at: f64,
}

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::new(ErrorKind::Io, format!("app config folder: {e}")))
}

fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::new(ErrorKind::Io, format!("app data folder: {e}")))
}

fn parses_as_json(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
}

/// Renames an unparsable settings file to `settings.corrupt-<ms>.json` so it is
/// never overwritten in place (SET-01).
fn set_aside(path: &Path, dir: &Path) -> AppResult<()> {
    let aside = dir.join(format!("settings.corrupt-{}.json", fs_ops::now_ms() as u64));
    fs::rename(path, &aside).map_err(|e| AppError::from_io(e, "set aside unreadable settings"))
}

/// `settings_load`: the raw settings JSON, or `null` on first run or after an
/// unparsable file was set aside.
#[tauri::command]
pub async fn settings_load(app: AppHandle) -> AppResult<Option<String>> {
    let dir = config_dir(&app)?;
    blocking(app, move |_| {
        let _serial = lock(&SETTINGS_LOCK);
        let path = dir.join(SETTINGS_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::from_io(e, "read settings")),
        };
        if parses_as_json(&bytes) {
            if let Ok(text) = String::from_utf8(bytes) {
                return Ok(Some(text));
            }
        }
        set_aside(&path, &dir)?;
        Ok(None)
    })
    .await
}

/// `settings_save`: atomically replaces the settings file; refuses text that is
/// not JSON. An existing file that does not parse (or cannot be read) is set
/// aside first, never overwritten.
#[tauri::command]
pub async fn settings_save(app: AppHandle, json: String) -> AppResult<()> {
    if !parses_as_json(json.as_bytes()) {
        return Err(AppError::new(ErrorKind::Io, "settings are not valid JSON"));
    }
    let dir = config_dir(&app)?;
    blocking(app, move |_| {
        let _serial = lock(&SETTINGS_LOCK);
        fs::create_dir_all(&dir).map_err(|e| AppError::from_io(e, "create app config folder"))?;
        let path = dir.join(SETTINGS_FILE);
        match fs::read(&path) {
            Ok(existing) if parses_as_json(&existing) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            // Unparsable or unreadable: keep it, out of the way.
            _ => set_aside(&path, &dir)?,
        }
        fs_ops::write_atomic(&path, json.as_bytes(), None, false, None).map(|_| ())
    })
    .await
}

/// `app_data/recovery/<fnv(root)>`.
fn recovery_dir(app_data: &Path, root: &Path) -> PathBuf {
    app_data
        .join(RECOVERY_DIR)
        .join(fs_ops::hash_hex(root.as_os_str().as_encoded_bytes()))
}

/// `<recovery dir>/<fnv(path)>.json`, keyed by the exact `VaultPath`.
fn recovery_file(app_data: &Path, root: &Path, rel: &str) -> PathBuf {
    recovery_dir(app_data, root).join(format!("{}.json", fs_ops::hash_hex(rel.as_bytes())))
}

/// Recovery commands check only the epoch, not the root's availability: the
/// copy must be writable exactly when the vault folder has gone away (VAULT-06).
fn recovery_target(
    app: &AppHandle,
    state: &vault::VaultState,
    epoch: u64,
    rel: &str,
) -> AppResult<PathBuf> {
    let root = state.root_for(epoch)?;
    if rel.is_empty() {
        return Err(AppError::new(
            ErrorKind::InvalidPath,
            "the vault folder has no recovery copy",
        ));
    }
    vault::split_rel(rel)?;
    Ok(recovery_file(&data_dir(app)?, &root, rel))
}

/// `recovery_write` (scoped): stores unsaved text for a note; newest wins.
#[tauri::command]
pub async fn recovery_write(
    app: AppHandle,
    epoch: u64,
    path: String,
    content: String,
    baseline: Option<Baseline>,
) -> AppResult<()> {
    let handle = app.clone();
    blocking(app, move |state| {
        let file = recovery_target(&handle, state, epoch, &path)?;
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| AppError::from_io(e, "create recovery folder"))?;
        }
        let copy = RecoveryCopy {
            path,
            content,
            baseline,
            saved_at: fs_ops::now_ms(),
        };
        let json = serde_json::to_vec(&copy)
            .map_err(|e| AppError::new(ErrorKind::Io, format!("encode recovery copy: {e}")))?;
        fs_ops::write_atomic(&file, &json, None, false, None).map(|_| ())
    })
    .await
}

/// `recovery_get` (scoped): the note's recovery copy, if any (not deleted).
#[tauri::command]
pub async fn recovery_get(
    app: AppHandle,
    epoch: u64,
    path: String,
) -> AppResult<Option<RecoveryCopy>> {
    let handle = app.clone();
    blocking(app, move |state| {
        let file = recovery_target(&handle, state, epoch, &path)?;
        let bytes = match fs::read(&file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::from_io(e, "read recovery copy")),
        };
        // An unreadable copy or a hash collision with another note is no copy.
        Ok(serde_json::from_slice::<RecoveryCopy>(&bytes)
            .ok()
            .filter(|copy| copy.path == path))
    })
    .await
}

/// `recovery_clear` (scoped): deletes the note's recovery copy.
#[tauri::command]
pub async fn recovery_clear(app: AppHandle, epoch: u64, path: String) -> AppResult<()> {
    let handle = app.clone();
    blocking(app, move |state| {
        let file = recovery_target(&handle, state, epoch, &path)?;
        match fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                Err(AppError::from_io(e, "delete recovery copy"))
            }
            _ => Ok(()),
        }
    })
    .await
}

/// Deletes this vault's recovery copies that are older than 30 days and whose
/// note no longer exists (SAVE-10). Copies of existing notes are kept: they still
/// hold text that was never saved. Best effort, and any doubt keeps the copy. A
/// vault folder without visible entries is not pruned at all: it may be the bare
/// mount point of a volume that is not mounted (yet), where every note would
/// look deleted (VAULT-06).
pub fn prune_recovery(app: &AppHandle, root: &Path) {
    if !shows_entries(root) {
        return;
    }
    let Ok(app_data) = data_dir(app) else { return };
    let Ok(list) = fs::read_dir(recovery_dir(&app_data, root)) else {
        return;
    };
    let Some(cutoff) = SystemTime::now().checked_sub(RECOVERY_MAX_AGE) else {
        return;
    };
    for entry in list.flatten() {
        let old = entry
            .metadata()
            .is_ok_and(|m| m.is_file() && m.modified().is_ok_and(|t| t < cutoff));
        if !old {
            continue;
        }
        let path = entry.path();
        let Ok(bytes) = fs::read(&path) else { continue };
        let gone = match serde_json::from_slice::<RecoveryCopy>(&bytes) {
            Ok(copy) => note_is_gone(root, &copy.path),
            // Unparsable: no note can ever restore it.
            Err(_) => true,
        };
        if gone {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Whether the folder has at least one entry that is not hidden.
fn shows_entries(root: &Path) -> bool {
    fs::read_dir(root).is_ok_and(|list| {
        list.flatten()
            .any(|entry| !fs_ops::is_hidden_name(&entry.file_name()))
    })
}

/// A note counts as deleted only when its file is missing (`NotFound`, not just
/// any error) while the folder it was in is still there: a deleted note leaves
/// its folder behind, an absent volume does not.
fn note_is_gone(root: &Path, rel: &str) -> bool {
    let Ok(note) = vault::resolve(root, rel) else {
        return false;
    };
    let folder_present = note
        .parent()
        .is_some_and(|dir| fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()));
    folder_present
        && fs::symlink_metadata(&note).is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_copies_unless_the_note_is_provably_gone() {
        let root = std::env::temp_dir().join(format!("mininote-test-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // An empty or hidden-only folder (a bare mount point) is never pruned.
        assert!(!shows_entries(&root));
        fs::write(root.join(".DS_Store"), b"").unwrap();
        assert!(!shows_entries(&root));
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("kept.md"), b"x").unwrap();
        assert!(shows_entries(&root));

        assert!(!note_is_gone(&root, "kept.md"));
        assert!(note_is_gone(&root, "deleted.md"));
        assert!(note_is_gone(&root, "Projects/deleted.md"));
        // Its folder is gone too: the volume may be absent, so keep the copy.
        assert!(!note_is_gone(&root, "Archive/old.md"));
        assert!(!note_is_gone(&root, "kept.md/below.md"));
        assert!(!note_is_gone(&root, "../escape.md"));
        fs::remove_dir_all(&root).unwrap();
    }
}
