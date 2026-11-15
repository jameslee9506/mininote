//! mininote's Tauri backend: plugins, commands, the macOS menu, the windows and the
//! exit-flush protocol (ARCHITECTURE §6.6).

mod error;
mod fs_ops;
mod search;
mod store;
mod vault;
mod watcher;
mod windows;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, Url, WebviewWindow, WindowEvent};

use crate::error::AppResult;
use crate::vault::{lock, Vaults};
use crate::windows::Windows;

/// Event name; mirrors `EVENT_FLUSH_REQUEST` in src/lib/ipc/events.ts.
const EVENT_FLUSH_REQUEST: &str = "app:flush-request";
/// Longer than the frontend's own budget (2 s flush + 1 s recovery copies), so a
/// slow flush is never cut short; a hung webview still exits.
const EXIT_FALLBACK: Duration = Duration::from_millis(4000);
#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "mininote-quit";

/// The quit in progress (ARCHITECTURE §6.6), managed by Tauri. Once a quit is
/// requested the app exits, so there is at most one.
#[derive(Default)]
struct ExitState {
    /// Every window has flushed, or the fallback fired: exit is no longer prevented.
    ready: AtomicBool,
    /// A quit was requested; its fallback is armed once.
    pending: AtomicBool,
    /// The exit code the quit was requested with.
    code: AtomicI32,
    /// The windows that have flushed for it (`app_exit_ready`).
    flushed: Mutex<HashSet<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::focus_last(app)
        }))
        // App updates (ARCHITECTURE §6.7): the frontend checks, downloads, installs and
        // restarts; release builds get the endpoint and public key from a config overlay.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // Size, position and maximized only: restoring visibility would show the
            // window before the frontend's first paint (PLAT-03, PLAT-04).
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(navigation_lock())
        .manage(Vaults::default())
        .manage(Windows::default())
        .manage(ExitState::default())
        .setup(|app| {
            // The first window exists already (tauri.conf.json); the others of the last
            // run come back now (VAULT-07).
            windows::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_open,
            vault::vault_close,
            vault::vault_focus,
            fs_ops::vault_list,
            fs_ops::note_read,
            fs_ops::note_write,
            fs_ops::note_create,
            fs_ops::dir_create,
            fs_ops::path_rename,
            fs_ops::path_trash,
            fs_ops::path_delete,
            fs_ops::path_exists,
            fs_ops::path_reveal,
            fs_ops::binary_write,
            search::search_text,
            store::recovery_write,
            store::recovery_get,
            store::recovery_clear,
            store::settings_load,
            store::settings_update,
            windows::window_new,
            windows::window_startup,
            app_quit,
            app_exit_ready,
        ]);
    // Windows and Linux get no menu bar: `Builder::menu` would add one to the window.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == MENU_QUIT {
            quit_requested(app);
        }
    });

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("mininote failed to start: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // A restart (the updater, once the new version is installed) cannot be held
            // back: Tauri ignores `prevent_exit` for it, so the frontend flushes before
            // asking for it (§6.7). Every other exit waits for the flush.
            if code != Some(tauri::RESTART_EXIT_CODE) && should_flush_first(app) {
                api.prevent_exit();
                request_flush(app, code.unwrap_or(0));
            } else {
                windows::mark_exiting(app);
            }
        }
        RunEvent::WindowEvent { label, event, .. } => {
            windows::on_window_event(app, &label, &event);
            // A window closed while the others flush for a quit no longer holds it back.
            let quitting = app
                .try_state::<ExitState>()
                .is_some_and(|exit| exit.pending.load(Ordering::SeqCst));
            if quitting && matches!(event, WindowEvent::Destroyed) {
                exit_when_flushed(app);
            }
        }
        RunEvent::Exit => {
            windows::mark_exiting(app);
            if let Some(vaults) = app.try_state::<Vaults>() {
                vaults.stop_all();
            }
        }
        _ => {}
    });
}

/// Defense in depth for READ-04 / PLAT-13: the webview may only navigate within
/// the app itself, so a link click the frontend failed to intercept cannot load
/// another page into a window that has IPC access (TECHNIQUES §9).
fn navigation_lock<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("mininote-navigation")
        .on_navigation(|webview, url| is_app_url(webview.app_handle(), url))
        .build()
}

/// The app's own origin: `tauri://localhost` (macOS, Linux),
/// `http(s)://tauri.localhost` (Windows), or `devUrl` while developing.
fn is_app_url<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || url.as_str() == "about:blank"
    {
        return true;
    }
    tauri::is_dev()
        && app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin())
}

/// Exit must wait for the windows to flush: not all of them have confirmed, and
/// one is still open (after the last window closed there is nothing to flush).
fn should_flush_first(app: &AppHandle) -> bool {
    let ready = app
        .try_state::<ExitState>()
        .is_none_or(|exit| exit.ready.load(Ordering::SeqCst));
    !ready && !app.webview_windows().is_empty()
}

/// Asks every window to flush (`app:flush-request`) and arms, once, a fallback
/// that exits after [`EXIT_FALLBACK`] even if some never answer.
fn request_flush(app: &AppHandle, code: i32) {
    let Some(exit) = app.try_state::<ExitState>() else {
        return;
    };
    let first = !exit.pending.swap(true, Ordering::SeqCst);
    if first {
        exit.code.store(code, Ordering::SeqCst);
    }
    if let Err(e) = app.emit(EVENT_FLUSH_REQUEST, ()) {
        log::warn!("emit {EVENT_FLUSH_REQUEST}: {e}");
    }
    if !first {
        return;
    }
    let handle = app.clone();
    let armed = std::thread::Builder::new()
        .name("mininote-exit-fallback".into())
        .spawn(move || {
            std::thread::sleep(EXIT_FALLBACK);
            finish_exit(&handle);
        });
    if armed.is_err() {
        // Without a fallback timer the app could hang on a dead webview; the
        // windows' own app_exit_ready still exit normally.
        exit.pending.store(false, Ordering::SeqCst);
    }
}

/// Exits once every open window has flushed for the quit.
fn exit_when_flushed(app: &AppHandle) {
    let Some(exit) = app.try_state::<ExitState>() else {
        return;
    };
    let open: Vec<String> = app.webview_windows().into_keys().collect();
    let all = {
        let flushed = lock(&exit.flushed);
        open.iter().all(|label| flushed.contains(label))
    };
    if all {
        finish_exit(app);
    }
}

/// Exits now, with the quit's code: the windows have flushed, or the fallback fired.
fn finish_exit(app: &AppHandle) {
    let code = app.try_state::<ExitState>().map_or(0, |exit| {
        exit.ready.store(true, Ordering::SeqCst);
        exit.code.load(Ordering::SeqCst)
    });
    windows::mark_exiting(app);
    app.exit(code);
}

/// Quitting from the app (the custom Quit item, Ctrl+Q) goes through the flush
/// protocol: tao never raises a preventable exit for the predefined Quit item
/// (Tauri #9198).
fn quit_requested(app: &AppHandle) {
    if should_flush_first(app) {
        request_flush(app, 0);
    } else {
        finish_exit(app);
    }
}

#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder, WINDOW_SUBMENU_ID,
    };

    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "Quit mininote")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "mininote")
        .about(Some(about))
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    // WKWebView needs the predefined Edit items for the clipboard shortcuts.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}

/// `app_quit` (Ctrl+Q on Windows and Linux): every window flushes, then the app
/// exits (ARCHITECTURE §6.6).
#[tauri::command]
async fn app_quit(app: AppHandle) -> AppResult<()> {
    quit_requested(&app);
    Ok(())
}

/// `app_exit_ready`: the calling window has flushed. The app exits once every open
/// window has; a window that quit on its own asks the others first (§6.6).
#[tauri::command]
async fn app_exit_ready(window: WebviewWindow) -> AppResult<()> {
    let app = window.app_handle();
    if let Some(exit) = app.try_state::<ExitState>() {
        lock(&exit.flushed).insert(window.label().to_owned());
        if !exit.pending.load(Ordering::SeqCst) {
            request_flush(app, 0);
        }
    }
    exit_when_flushed(app);
    Ok(())
}
