//! The app's windows (ARCHITECTURE §6.6, VAULT-07): opening another one, the
//! folder each one reopens at the next launch, and the window a second launch
//! brings forward. Each window has a vault of its own (`vault.rs`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::fs_ops;
use crate::vault::{lock, Vaults};

/// The window the app starts with. Its entry in tauri.conf.json is the template of
/// every window.
pub const MAIN_WINDOW: &str = "main";
/// The other windows are `w2`, `w3`…; no label is given out twice while the app runs.
const LABEL_PREFIX: &str = "w";
/// The folder each window had open, reopened at the next launch (app config folder).
const WINDOWS_FILE: &str = "windows.json";
/// A damaged or hand-edited list never opens more windows than this.
const MAX_RESTORED: usize = 16;
/// How far a new window sits down and to the right of the one it came from (logical px).
const CASCADE_STEP: f64 = 28.0;

/// What a window opens when its page starts (`WindowStartup` in src/lib/types.ts).
#[derive(Debug, Clone, Default, Serialize)]
pub struct WindowStartup {
    /// The folder to open as its vault.
    pub vault: Option<String>,
    /// No window list was saved yet (an older version ran last): the window reopens
    /// the settings' last vault instead.
    pub last: bool,
}

/// One window of the list kept for the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SavedWindow {
    /// The window-state plugin keeps the window's size and place under its label.
    label: String,
    vault: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SavedWindows {
    #[serde(default)]
    windows: Vec<SavedWindow>,
}

/// Window bookkeeping, managed by Tauri.
pub struct Windows {
    /// What each window opens when its page starts, until it asks (`window_startup`).
    startup: Mutex<HashMap<String, WindowStartup>>,
    /// The number of the next `w<n>` label.
    next: AtomicU64,
    /// The window focused last.
    focused: Mutex<Option<String>>,
    /// The app is exiting: windows closing now stay in the saved list.
    exiting: AtomicBool,
    /// The list as last written or loaded. Its lock also serializes the writes.
    saved: Mutex<Option<Vec<SavedWindow>>>,
}

impl Default for Windows {
    fn default() -> Self {
        Self {
            startup: Mutex::new(HashMap::new()),
            next: AtomicU64::new(2),
            focused: Mutex::new(None),
            exiting: AtomicBool::new(false),
            saved: Mutex::new(None),
        }
    }
}

impl Windows {
    fn allocate(&self) -> String {
        format!("{LABEL_PREFIX}{}", self.next.fetch_add(1, Ordering::SeqCst))
    }
}

/// `n` of a `w<n>` label (n ≥ 2, written without leading zeros).
fn label_number(label: &str) -> Option<u64> {
    let digits = label.strip_prefix(LABEL_PREFIX)?;
    let n: u64 = digits.parse().ok()?;
    (n >= 2 && n.to_string() == digits).then_some(n)
}

/// The main window first, then the others by number.
fn label_order(label: &str) -> u64 {
    if label == MAIN_WINDOW {
        0
    } else {
        label_number(label).unwrap_or(u64::MAX)
    }
}

/// At launch (setup): the first window reopens its folder, and the other windows
/// that had a vault open when the app last ran come back, each under its old label,
/// so at its old size and place. Without a saved list (an older version ran last),
/// the first window reopens the settings' last vault, as it always did.
pub fn restore(app: &AppHandle) {
    let windows = app.state::<Windows>();
    let Some(list) = load(app) else {
        lock(&windows.startup).insert(
            MAIN_WINDOW.to_owned(),
            WindowStartup {
                vault: None,
                last: true,
            },
        );
        return;
    };
    *lock(&windows.saved) = Some(list.clone());
    let mut rest = list;
    if !rest.is_empty() {
        let first = rest
            .iter()
            .position(|w| w.label == MAIN_WINDOW)
            .unwrap_or(0);
        let first = rest.remove(first);
        lock(&windows.startup).insert(
            MAIN_WINDOW.to_owned(),
            WindowStartup {
                vault: Some(first.vault),
                last: false,
            },
        );
    }
    let top = rest
        .iter()
        .filter_map(|w| label_number(&w.label))
        .max()
        .unwrap_or(1);
    windows.next.store(top + 1, Ordering::SeqCst);
    for saved in rest {
        let label = if label_number(&saved.label).is_some() {
            saved.label
        } else {
            windows.allocate()
        };
        if let Err(e) = create(app, &label, Some(saved.vault), None) {
            log::warn!("restore window {label}: {e}");
        }
    }
}

/// The saved list, cleaned up: known labels, absolute folders, each label and each
/// folder once, at most [`MAX_RESTORED`] windows. `None` when there is no list or
/// it does not parse.
fn load(app: &AppHandle) -> Option<Vec<SavedWindow>> {
    let path = app.path().app_config_dir().ok()?.join(WINDOWS_FILE);
    let bytes = fs::read(path).ok()?;
    let saved: SavedWindows = serde_json::from_slice(&bytes).ok()?;
    Some(clean(saved.windows))
}

fn clean(list: Vec<SavedWindow>) -> Vec<SavedWindow> {
    let mut labels = HashSet::new();
    let mut vaults = HashSet::new();
    let mut kept = Vec::new();
    for w in list {
        let known = w.label == MAIN_WINDOW || label_number(&w.label).is_some();
        if !known
            || !Path::new(&w.vault).is_absolute()
            || labels.contains(&w.label)
            || vaults.contains(&w.vault)
        {
            continue;
        }
        labels.insert(w.label.clone());
        vaults.insert(w.vault.clone());
        kept.push(w);
        if kept.len() == MAX_RESTORED {
            break;
        }
    }
    kept
}

/// Saves the folder each window has open, for the next launch. Once the app is
/// exiting the list stays as it is (every window reopens), and an unchanged list
/// is not written again. The file is written off the calling thread.
pub fn remember_vaults(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let windows = app.state::<Windows>();
        let mut saved = lock(&windows.saved);
        if windows.exiting.load(Ordering::SeqCst) {
            return;
        }
        let list = open_vaults(&app);
        if saved.as_ref() == Some(&list) {
            return;
        }
        match write_list(&app, &list) {
            Ok(()) => *saved = Some(list),
            Err(e) => log::warn!("save the window list: {e}"),
        }
    });
}

/// The windows with a vault, the main window first.
fn open_vaults(app: &AppHandle) -> Vec<SavedWindow> {
    let mut list: Vec<SavedWindow> = app
        .state::<Vaults>()
        .roots()
        .into_iter()
        .filter_map(|(label, root)| {
            Some(SavedWindow {
                vault: root.to_str()?.to_owned(),
                label,
            })
        })
        .collect();
    list.sort_by_key(|w| label_order(&w.label));
    list
}

fn write_list(app: &AppHandle, list: &[SavedWindow]) -> AppResult<()> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(ErrorKind::Io, format!("app config folder: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| AppError::from_io(e, "create app config folder"))?;
    let json = serde_json::to_vec(&SavedWindows {
        windows: list.to_vec(),
    })
    .map_err(|e| AppError::new(ErrorKind::Io, format!("encode the window list: {e}")))?;
    fs_ops::write_atomic(&dir.join(WINDOWS_FILE), &json, None, false, None).map(|_| ())
}

/// The app is exiting: the saved list stays as it is.
pub fn mark_exiting(app: &AppHandle) {
    if let Some(windows) = app.try_state::<Windows>() {
        windows.exiting.store(true, Ordering::SeqCst);
    }
}

/// Window events from the run loop. Focus is remembered. A closed window lets go
/// of its vault and leaves the saved list, unless it was the last window: the app
/// exits then, and reopens it next time.
pub fn on_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    let Some(windows) = app.try_state::<Windows>() else {
        return;
    };
    match event {
        WindowEvent::Focused(true) => *lock(&windows.focused) = Some(label.to_owned()),
        WindowEvent::Destroyed => {
            lock(&windows.startup).remove(label);
            if let Some(vaults) = app.try_state::<Vaults>() {
                vaults.remove(label);
            }
            if app.webview_windows().keys().any(|other| other != label) {
                remember_vaults(app);
            }
        }
        _ => {}
    }
}

/// Builds window `label` from the main window's configuration, hidden until its
/// page has painted (PLAT-03). `vault` is the folder it opens at startup; `from`,
/// the window it was opened from, gives its place.
fn create(
    app: &AppHandle,
    label: &str,
    vault: Option<String>,
    from: Option<&WebviewWindow>,
) -> AppResult<WebviewWindow> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorKind::Io, "no window configuration"))?;
    config.label = label.to_owned();
    let windows = app.state::<Windows>();
    if let Some(vault) = vault {
        lock(&windows.startup).insert(
            label.to_owned(),
            WindowStartup {
                vault: Some(vault),
                last: false,
            },
        );
    }
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build());
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            lock(&windows.startup).remove(label);
            return Err(AppError::new(ErrorKind::Io, format!("open a window: {e}")));
        }
    };
    if let Some(from) = from {
        cascade(&window, from);
    }
    Ok(window)
}

/// Places a new window over the one it came from, one step down and to the right,
/// at the same size, starting over near the top-left corner of that window's screen
/// where the step would leave it; maximized when that one is. Its label's saved
/// place, if any, gives way. Next to a full-screen window the OS places it.
fn cascade(window: &WebviewWindow, from: &WebviewWindow) {
    if from.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(position) = from.outer_position() else {
        return;
    };
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    if from.is_maximized().unwrap_or(false) {
        let _ = window.set_position(position);
        let _ = window.maximize();
        return;
    }
    let (Ok(size), Ok(outer)) = (from.inner_size(), from.outer_size()) else {
        return;
    };
    let step = (CASCADE_STEP * from.scale_factor().unwrap_or(1.0)).round() as i32;
    let (mut x, mut y) = (position.x + step, position.y + step);
    if let Ok(Some(monitor)) = from.current_monitor() {
        let area = monitor.work_area();
        let right = area.position.x + area.size.width as i32;
        let bottom = area.position.y + area.size.height as i32;
        if x + outer.width as i32 > right || y + outer.height as i32 > bottom {
            x = area.position.x + step;
            y = area.position.y + step;
        }
    }
    let _ = window.set_size(size);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Brings window `label` forward, out of the Dock or the taskbar if need be.
pub fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A second launch (PLAT-05): the window focused last comes forward, else the first.
pub fn focus_last(app: &AppHandle) {
    let last = app
        .try_state::<Windows>()
        .and_then(|windows| lock(&windows.focused).clone());
    let label = last
        .filter(|label| app.get_webview_window(label).is_some())
        .or_else(|| {
            app.webview_windows()
                .into_keys()
                .min_by_key(|label| label_order(label))
        });
    if let Some(label) = label {
        focus(app, &label);
    }
}

/// `window_new`: opens another window, on the Welcome screen, over the calling one
/// (VAULT-07).
#[tauri::command]
pub async fn window_new(window: WebviewWindow) -> AppResult<()> {
    let app = window.app_handle();
    let label = app.state::<Windows>().allocate();
    create(app, &label, None, Some(&window)).map(|_| ())
}

/// `window_startup`: what the calling window opens when its page starts, given out
/// once. A page that starts again in the same window finds the vault it had.
#[tauri::command]
pub async fn window_startup(window: WebviewWindow) -> AppResult<WindowStartup> {
    let app = window.app_handle();
    let label = window.label();
    let open = app
        .try_state::<Vaults>()
        .and_then(|vaults| vaults.get(label))
        .and_then(|state| state.root_path())
        .and_then(|root| root.to_str().map(str::to_owned));
    let pending = app
        .try_state::<Windows>()
        .and_then(|windows| lock(&windows.startup).remove(label));
    Ok(match open {
        Some(vault) => WindowStartup {
            vault: Some(vault),
            last: false,
        },
        None => pending.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(label: &str, vault: &str) -> SavedWindow {
        SavedWindow {
            label: label.into(),
            vault: vault.into(),
        }
    }

    #[test]
    fn labels_are_main_or_numbered() {
        assert_eq!(label_number("w2"), Some(2));
        assert_eq!(label_number("w17"), Some(17));
        for bad in ["w1", "w0", "w02", "w", "w-3", "main", "x2", "w2x"] {
            assert_eq!(label_number(bad), None, "{bad}");
        }
        let mut labels = vec!["w10", "main", "w3", "other"];
        labels.sort_by_key(|l| label_order(l));
        assert_eq!(labels, vec!["main", "w3", "w10", "other"]);
    }

    #[test]
    fn saved_list_keeps_each_window_and_folder_once() {
        let root = if cfg!(windows) { "C:\\notes" } else { "/notes" };
        let other = if cfg!(windows) { "C:\\work" } else { "/work" };
        let list = clean(vec![
            saved("w4", root),
            saved("bogus", other),
            saved("w5", "relative/folder"),
            saved("w4", other),
            saved("main", root),
            saved("main", other),
            saved("w6", other),
        ]);
        assert_eq!(list, vec![saved("w4", root), saved("main", other)]);
        let many: Vec<_> = (2..40)
            .map(|n| saved(&format!("w{n}"), &format!("{root}{n}")))
            .collect();
        assert_eq!(clean(many).len(), MAX_RESTORED);
    }
}
