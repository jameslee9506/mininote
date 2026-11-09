//! mininote's Tauri backend: plugins, commands, the macOS menu and the exit-flush
//! protocol (ARCHITECTURE §6.6).

mod error;
mod fs_ops;
mod search;
mod store;
mod vault;
mod watcher;

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, Url};

use crate::error::AppResult;
use crate::vault::VaultState;

/// Event name; mirrors `EVENT_FLUSH_REQUEST` in src/lib/ipc/events.ts.
const EVENT_FLUSH_REQUEST: &str = "app:flush-request";
/// Longer than the frontend's own budget (2 s flush + 1 s recovery copies), so a
/// slow flush is never cut short; a hung webview still exits.
const EXIT_FALLBACK: Duration = Duration::from_millis(4000);
const MAIN_WINDOW: &str = "main";
#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "mininote-quit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        focus_main(app)
    }));
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
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            vault::vault_open,
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
            store::settings_save,
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
            if should_flush_first(app) {
                api.prevent_exit();
                request_flush(app, code.unwrap_or(0));
            }
        }
        RunEvent::Exit => {
            if let Some(state) = app.try_state::<VaultState>() {
                state.stop_watcher();
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

/// A second launch brings the existing window forward (PLAT-05).
#[cfg(desktop)]
fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Exit must wait for the frontend to flush: it has not confirmed yet and its
/// window still exists (after the last window closed there is nothing to flush).
fn should_flush_first(app: &AppHandle) -> bool {
    let ready = app
        .try_state::<VaultState>()
        .is_none_or(|state| state.exit_ready.load(Ordering::SeqCst));
    !ready && app.get_webview_window(MAIN_WINDOW).is_some()
}

/// Asks the frontend to flush (`app:flush-request`) and arms, once, a fallback
/// that exits after [`EXIT_FALLBACK`] even if it never answers.
fn request_flush(app: &AppHandle, code: i32) {
    if let Err(e) = app.emit(EVENT_FLUSH_REQUEST, ()) {
        log::warn!("emit {EVENT_FLUSH_REQUEST}: {e}");
    }
    let Some(state) = app.try_state::<VaultState>() else {
        return;
    };
    if state.exit_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let armed = std::thread::Builder::new()
        .name("mininote-exit-fallback".into())
        .spawn(move || {
            std::thread::sleep(EXIT_FALLBACK);
            if let Some(state) = app.try_state::<VaultState>() {
                state.exit_ready.store(true, Ordering::SeqCst);
            }
            app.exit(code);
        });
    if armed.is_err() {
        // Without a fallback timer the app could hang on a dead webview; the
        // frontend's own app_exit_ready still exits normally.
        state.exit_pending.store(false, Ordering::SeqCst);
    }
}

/// The custom Quit item (Cmd+Q): tao never raises a preventable exit for the
/// predefined one (Tauri #9198), so quitting goes through the flush protocol.
#[cfg(target_os = "macos")]
fn quit_requested(app: &AppHandle) {
    if should_flush_first(app) {
        request_flush(app, 0);
    } else {
        app.exit(0);
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

/// `app_exit_ready`: the frontend has flushed; exit now (ARCHITECTURE §6.6).
#[tauri::command]
async fn app_exit_ready(app: AppHandle) -> AppResult<()> {
    if let Some(state) = app.try_state::<VaultState>() {
        state.exit_ready.store(true, Ordering::SeqCst);
    }
    app.exit(0);
    Ok(())
}
