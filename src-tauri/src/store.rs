//! Settings JSON and recovery copies, kept in the OS app folders, never in the
//! vault (ARCHITECTURE §5, SET-01, SAVE-10, VAULT-04). Every window writes the
//! settings as patches, which the others hear (ARCHITECTURE §7).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::fs_ops::{self, Baseline};
use crate::vault::{self, background, blocking, lock};

/// Event name; mirrors `EVENT_SETTINGS_CHANGED` in src/lib/ipc/events.ts.
const EVENT_SETTINGS_CHANGED: &str = "settings:changed";
const SETTINGS_FILE: &str = "settings.json";
/// The app's identifier in tauri.conf.json: the OS keeps the app's folders under it.
const APP_ID: &str = "com.mininote.desktop";
const RECOVERY_DIR: &str = "recovery";
/// Recovery copies whose note is gone are pruned after this long (SAVE-10).
const RECOVERY_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Serializes settings writes, including the corrupt-file check before each one,
/// and the `settings:changed` events, which therefore go out in the order applied.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// `SettingsPatch` in src/lib/types.ts: the settings a window changed, and the
/// vault sessions it replaced (`null` removes one), by vault root.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SettingsPatch {
    #[serde(default)]
    pub settings: Map<String, Value>,
    #[serde(default)]
    pub sessions: Map<String, Value>,
}

/// `SettingsChangedPayload` in src/lib/types.ts: an applied patch and the window
/// that wrote it.
#[derive(Debug, Clone, Serialize)]
struct SettingsChanged<'a> {
    origin: &'a str,
    settings: &'a Map<String, Value>,
    sessions: &'a Map<String, Value>,
}

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

/// The app config folder, found without the app: a subcommand of `mininote` runs
/// before there is one (PLAT-15). It is the folder Tauri's `app_config_dir` names,
/// the OS's folder for settings with the app's identifier in it.
pub fn config_dir_alone() -> Option<PathBuf> {
    let absolute =
        |dir: std::ffi::OsString| Some(PathBuf::from(dir)).filter(|dir| dir.is_absolute());
    let home = || std::env::home_dir().filter(|home| home.is_absolute());
    let base = if cfg!(target_os = "macos") {
        home()?.join("Library").join("Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").and_then(absolute)?
    } else {
        match std::env::var_os("XDG_CONFIG_HOME").and_then(absolute) {
            Some(dir) => dir,
            None => home()?.join(".config"),
        }
    };
    Some(base.join(APP_ID))
}

/// What the settings say of the vaults (`Settings` in src/lib/types.ts): the
/// folders opened as one, the most recent first, and the one opened last.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnownVaults {
    pub recent: Vec<String>,
    pub last: Option<String>,
}

/// The vaults the settings in `config_dir` remember; none when there are no
/// settings, or none that can be read. For the subcommands of `mininote`
/// (PLAT-15), which only ever read the settings: the app alone writes them.
pub fn known_vaults(config_dir: &Path) -> KnownVaults {
    fs::read(config_dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|doc| vaults_in(&doc))
        .unwrap_or_default()
}

/// `recentVaults` and `lastVault` of a settings document: absolute paths, each
/// once. The vault opened last is one of them, the first if the list lacks it.
fn vaults_in(doc: &Value) -> KnownVaults {
    let settings = &doc["settings"];
    let folder = |value: &Value| {
        value
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
            .map(str::to_owned)
    };
    let last = folder(&settings["lastVault"]);
    let listed = settings["recentVaults"].as_array();
    let mut recent: Vec<String> = Vec::new();
    for path in listed.into_iter().flatten().filter_map(folder) {
        if !recent.contains(&path) {
            recent.push(path);
        }
    }
    if let Some(last) = last.as_ref().filter(|last| !recent.contains(last)) {
        recent.insert(0, last.clone());
    }
    KnownVaults { recent, last }
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
    background(move || {
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

/// `settings_update`: applies a window's patch to the settings file (atomically),
/// then tells every window, the sender included, so each keeps an up-to-date copy
/// (`settings:changed`, ARCHITECTURE §7). An existing file that is not a JSON
/// object (or cannot be read) is set aside first, never overwritten.
#[tauri::command]
pub async fn settings_update(window: WebviewWindow, patch: SettingsPatch) -> AppResult<()> {
    let app = window.app_handle().clone();
    let origin = window.label().to_owned();
    let dir = config_dir(&app)?;
    background(move || {
        let _serial = lock(&SETTINGS_LOCK);
        fs::create_dir_all(&dir).map_err(|e| AppError::from_io(e, "create app config folder"))?;
        let path = dir.join(SETTINGS_FILE);
        let mut doc = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(doc)) => doc,
                // Not a settings document: keep it, out of the way.
                _ => {
                    set_aside(&path, &dir)?;
                    Map::new()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Map::new(),
            Err(_) => {
                set_aside(&path, &dir)?;
                Map::new()
            }
        };
        apply_patch(&mut doc, &patch);
        let json = serde_json::to_vec(&Value::Object(doc))
            .map_err(|e| AppError::new(ErrorKind::Io, format!("encode settings: {e}")))?;
        fs_ops::write_atomic(&path, &json, None, false, None)?;
        let changed = SettingsChanged {
            origin: &origin,
            settings: &patch.settings,
            sessions: &patch.sessions,
        };
        if let Err(e) = app.emit(EVENT_SETTINGS_CHANGED, changed) {
            log::warn!("emit {EVENT_SETTINGS_CHANGED}: {e}");
        }
        Ok(())
    })
    .await
}

/// Merges `patch` into the settings document `{ settings, sessions }`: each
/// setting replaces its own key, each session its vault's, and a `null` session
/// removes it. A part that is not an object starts over empty.
fn apply_patch(doc: &mut Map<String, Value>, patch: &SettingsPatch) {
    let mut settings = take_object(doc, "settings");
    for (key, value) in &patch.settings {
        settings.insert(key.clone(), value.clone());
    }
    doc.insert("settings".into(), Value::Object(settings));
    let mut sessions = take_object(doc, "sessions");
    for (root, session) in &patch.sessions {
        if session.is_null() {
            sessions.remove(root);
        } else {
            sessions.insert(root.clone(), session.clone());
        }
    }
    doc.insert("sessions".into(), Value::Object(sessions));
}

fn take_object(doc: &mut Map<String, Value>, key: &str) -> Map<String, Value> {
    match doc.remove(key) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
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
    window: WebviewWindow,
    epoch: u64,
    path: String,
    content: String,
    baseline: Option<Baseline>,
) -> AppResult<()> {
    let handle = window.app_handle().clone();
    blocking(&window, move |state| {
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
    window: WebviewWindow,
    epoch: u64,
    path: String,
) -> AppResult<Option<RecoveryCopy>> {
    let handle = window.app_handle().clone();
    blocking(&window, move |state| {
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
pub async fn recovery_clear(window: WebviewWindow, epoch: u64, path: String) -> AppResult<()> {
    let handle = window.app_handle().clone();
    blocking(&window, move |state| {
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
    use serde_json::json;

    #[test]
    fn patches_replace_their_own_keys_and_sessions() {
        let mut doc = serde_json::from_str::<Value>(
            r#"{"settings":{"fontSize":15,"theme":"dark","future":1},"sessions":{"/a":{"lastFile":"x.md"},"/b":{"lastFile":null}}}"#,
        )
        .unwrap();
        let Value::Object(doc_map) = &mut doc else {
            panic!("not an object")
        };
        let patch: SettingsPatch = serde_json::from_str(
            r#"{"settings":{"fontSize":17},"sessions":{"/a":null,"/c":{"lastFile":"y.md"}}}"#,
        )
        .unwrap();
        apply_patch(doc_map, &patch);
        assert_eq!(
            doc,
            serde_json::from_str::<Value>(
                r#"{"settings":{"fontSize":17,"theme":"dark","future":1},"sessions":{"/b":{"lastFile":null},"/c":{"lastFile":"y.md"}}}"#,
            )
            .unwrap()
        );

        // A part that is not an object, or missing, starts over empty.
        let mut odd = Map::new();
        odd.insert("settings".into(), Value::from(3));
        apply_patch(
            &mut odd,
            &serde_json::from_str(r#"{"settings":{"theme":"light"}}"#).unwrap(),
        );
        assert_eq!(
            Value::Object(odd),
            serde_json::from_str::<Value>(r#"{"settings":{"theme":"light"},"sessions":{}}"#)
                .unwrap()
        );
    }

    #[test]
    fn the_settings_name_the_known_vaults() {
        // The folder found without the app is the one Tauri finds with it.
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);

        let (a, b, c) = if cfg!(windows) {
            ("C:\\a", "C:\\b", "C:\\c")
        } else {
            ("/a", "/b", "/c")
        };
        let doc =
            json!({ "settings": { "recentVaults": [a, 3, "relative", b, a], "lastVault": c } });
        let known = vaults_in(&doc);
        assert_eq!(known.recent, [c, a, b]);
        assert_eq!(known.last.as_deref(), Some(c));
        // No settings yet, or settings of another shape: no vault is known.
        assert_eq!(vaults_in(&json!({})), KnownVaults::default());
        assert_eq!(vaults_in(&json!({ "settings": 3 })), KnownVaults::default());
    }

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
