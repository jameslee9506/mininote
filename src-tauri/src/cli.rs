//! The `mininote` command (PLAT-14, ARCHITECTURE §6.9): the folders and files a
//! command line names, the restart that repeats one, and the command's place in the
//! shell's PATH, which Settings turns on and off (macOS). A line that begins with
//! a subcommand never comes here: `headless.rs` answers it (PLAT-15).

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::vault::background;
use crate::windows;

/// A command line opens this many folders at most: a stray glob never fills the screen.
const MAX_TARGETS: usize = 8;
/// Marks a restart in the app config folder, for the launch that follows it.
const RESTART_FILE: &str = "restarting";
/// A restart's launch comes right after it; an older mark is one that never led to one.
const RESTART_WINDOW: Duration = Duration::from_secs(30);

/// What one path of a command line asks for: a folder to show as a vault, and the
/// file to show in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The folder, canonical: the root `vault_open` makes of it.
    pub vault: String,
    /// The file's name in that folder, as it was typed. The frontend finds the
    /// spelling the folder lists it under.
    pub file: Option<String>,
}

/// The folders and files the command line `args` names (its first entry is the
/// program), and one message for each path that names nothing. A relative path
/// starts from `cwd`. A folder is its own target; a file's is the folder it is in.
/// Opening has no options: an argument that looks like one is skipped, and after
/// `--` every argument is a path.
pub fn targets(args: &[String], cwd: &Path) -> (Vec<Target>, Vec<String>) {
    let mut targets: Vec<Target> = Vec::new();
    let mut errors = Vec::new();
    let mut options = true;
    for arg in args.iter().skip(1) {
        if options && arg == "--" {
            options = false;
            continue;
        }
        if arg.is_empty() || (options && arg.starts_with('-')) {
            continue;
        }
        match target(cwd, arg) {
            Ok(target) => {
                if let Some(same) = targets.iter_mut().find(|t| t.vault == target.vault) {
                    // One window shows a folder: a later file in it replaces an earlier one.
                    if target.file.is_some() {
                        same.file = target.file;
                    }
                } else if targets.len() < MAX_TARGETS {
                    targets.push(target);
                }
            }
            Err(e) => errors.push(format!("{arg}: {e}")),
        }
    }
    (targets, errors)
}

fn target(cwd: &Path, arg: &str) -> io::Result<Target> {
    let path = cwd.join(arg);
    if fs::metadata(&path)?.is_dir() {
        return Ok(Target {
            vault: canonical(&path)?,
            file: None,
        });
    }
    // A file is shown in the folder it is in, under its name there: a link is not
    // followed to the folder of the file it leads to (TREE-18).
    let folder = match path.parent() {
        Some(folder) if !folder.as_os_str().is_empty() => folder,
        _ => Path::new("."),
    };
    Ok(Target {
        vault: canonical(folder)?,
        file: path.file_name().and_then(OsStr::to_str).map(str::to_owned),
    })
}

/// The canonical form `vault_open` gives a folder, so a target names a vault the
/// way the windows do.
fn canonical(folder: &Path) -> io::Result<String> {
    dunce::canonicalize(folder)?
        .into_os_string()
        .into_string()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the path is not valid UTF-8"))
}

/// The targets of the command line this process was started with. A path that
/// names nothing is reported on stderr, where the command was typed, and the app
/// starts all the same.
pub fn launch() -> Vec<Target> {
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let (targets, errors) = targets(&args, &cwd);
    // Never `eprintln!`: it panics once the terminal that started the app is gone.
    let mut stderr = io::stderr().lock();
    for error in errors {
        let _ = writeln!(stderr, "mininote: {error}");
    }
    targets
}

/// A second launch (PLAT-05), which handed over its command line and exited: its
/// folders and files open here; without any, the window used last comes forward.
pub fn relaunched(app: &AppHandle, args: Vec<String>, cwd: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The second launch reported its own errors, in its terminal.
        let (targets, _) = targets(&args, Path::new(&cwd));
        if targets.is_empty() {
            windows::focus_last(&app);
        } else {
            windows::open(&app, targets, false);
        }
    });
}

/// The app is about to restart (an update, §6.7). Tauri starts it again with the
/// same command line, whose paths this run has shown already.
pub fn mark_restart(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if let Err(e) = fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join(RESTART_FILE), b"")) {
        log::warn!("mark the restart: {e}");
    }
}

/// Whether this launch is the one a restart asked for: its command line is the last
/// run's, and is not followed again. Asked once per launch; the mark is removed.
pub fn take_restart(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_config_dir() else {
        return false;
    };
    let mark = dir.join(RESTART_FILE);
    let fresh = fs::metadata(&mark)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|written| written.elapsed().ok())
        .is_some_and(|age| age < RESTART_WINDOW);
    let _ = fs::remove_file(&mark);
    fresh
}

/// `cli_status`: whether the `mininote` command is in the shell's PATH and starts
/// this app; `null` where the app cannot put it there (`CliStatus` in src/lib/types.ts).
#[tauri::command]
pub async fn cli_status() -> AppResult<Option<bool>> {
    background(|| Ok(shell::status())).await
}

/// `cli_install`: puts the command in the shell's PATH. Where that needs an
/// administrator, the system asks for the password under `prompt`; declining it
/// changes nothing. Another program's `mininote` is never replaced (`exists`).
/// Returns the status afterwards.
#[tauri::command]
pub async fn cli_install(prompt: String) -> AppResult<Option<bool>> {
    background(move || shell::install(&prompt)).await
}

/// `cli_uninstall`: removes the command this app installed, asking as `cli_install`
/// does. Returns the status afterwards.
#[tauri::command]
pub async fn cli_uninstall(prompt: String) -> AppResult<Option<bool>> {
    background(move || shell::uninstall(&prompt)).await
}

/// macOS: an app bundle is in no PATH, and nothing installs it, so the command is a
/// script the app writes on request. Its place is `/usr/local/bin`: the one folder
/// of every Mac's PATH (`/etc/paths`) that is meant for such commands. A folder the
/// user's shell profile adds is not known to an app started from the Dock.
#[cfg(target_os = "macos")]
mod shell {
    use std::fs;
    use std::io::{self, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;

    use crate::error::{AppError, AppResult, ErrorKind};
    use crate::headless;

    const BIN_DIR: &str = "/usr/local/bin";
    const COMMAND: &str = "/usr/local/bin/mininote";

    /// How the script begins: what tells this app's command from another program of
    /// that name. Never change it, or installed commands are no longer recognized.
    const HEAD: &str =
        "#!/bin/sh\n# mininote [path ...]: opens folders, and files in their folder, in mininote.\n";

    /// The rest of the script; `@APP@` is the app bundle and `@EXE@` the name of its
    /// program, each quoted for the shell.
    ///
    /// A subcommand (PLAT-15) is the program's own work: it prints in the terminal
    /// and shows no window, so the script runs the program itself, in place of the
    /// shell. It asks the program first whether the first word is one, and so
    /// stays as it is when a subcommand is added.
    ///
    /// Anything else is paths. They go to the app as arguments, absolute because an
    /// app starts in `/`.
    /// `open` starts it, so that macOS counts the files it reads as the app's and not
    /// as the terminal's, and the shell is free at once. `-n` starts a new process,
    /// which becomes the app, or hands the paths to the running app and exits
    /// (single-instance). In that second case it stays in the background (`-g`): it
    /// would take the place in front and then quit, and the running app brings the
    /// window it opens forward itself. `pgrep -x` matches the app's process, never
    /// this script, whose own process is `sh`.
    const BODY: &str = r#"# Written by Mininote. Its setting for this command removes the file again.
app=@APP@
bin=$app/Contents/MacOS/@EXE@

# A subcommand (mininote --help lists them) is answered here in the terminal, by
# the app's program itself. The program says whether the first word is one.
if [ "$#" -gt 0 ] && "$bin" @PROBE@ "$1" 2>/dev/null; then
  exec "$bin" "$@"
fi

case ${1-} in
  --) shift ;;
esac
[ "$#" -gt 0 ] || exec /usr/bin/open -a "$app"

status=0
n=$#
while [ "$n" -gt 0 ]; do
  p=$1
  shift
  n=$((n - 1))
  case $p in
    /*) ;;
    *) p=$PWD/$p ;;
  esac
  if [ -e "$p" ]; then
    set -- "$@" "$p"
  else
    printf 'mininote: %s: No such file or directory\n' "$p" >&2
    status=1
  fi
done
[ "$#" -gt 0 ] || exit "$status"

if /usr/bin/pgrep -qx mininote; then
  /usr/bin/open -n -g -a "$app" --args "$@" || exit
else
  /usr/bin/open -n -a "$app" --args "$@" || exit
fi
exit "$status"
"#;

    /// AppleScript for `osascript`, which is given the staged script and the prompt.
    /// Root copies the script under a temporary name and renames it, so a link at
    /// the command's path is replaced and never written through.
    const INSTALL: &[&str] = &[
        "on run argv",
        "do shell script \"/bin/mkdir -p /usr/local/bin && t=$(/usr/bin/mktemp /usr/local/bin/.mininote.XXXXXX) && /bin/cat \" & quoted form of (item 1 of argv) & \" > $t && /bin/chmod 755 $t && /bin/mv -f $t /usr/local/bin/mininote\" with prompt (item 2 of argv) with administrator privileges",
        "end run",
    ];
    /// AppleScript for `osascript`, which is given the prompt.
    const REMOVE: &[&str] = &[
        "on run argv",
        "do shell script \"/bin/rm -f /usr/local/bin/mininote\" with prompt (item 1 of argv) with administrator privileges",
        "end run",
    ];

    pub fn status() -> Option<bool> {
        let bundle = bundle()?;
        Some(fs::read_to_string(COMMAND).is_ok_and(|text| starts(&text, &bundle.app)))
    }

    pub fn install(prompt: &str) -> AppResult<Option<bool>> {
        let bundle = bundle().ok_or_else(|| {
            AppError::new(ErrorKind::Io, "the app does not run from an app bundle")
        })?;
        let taken = fs::symlink_metadata(COMMAND).is_ok();
        if taken && !fs::read_to_string(COMMAND).is_ok_and(|text| is_ours(&text)) {
            return Err(AppError::new(
                ErrorKind::Exists,
                format!("{COMMAND} is another program"),
            ));
        }
        let script = script(&bundle);
        match write(&script) {
            Ok(()) => {}
            // The folder is root's, as on every Mac that nothing changed it on.
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                write_as_root(&script, prompt)?
            }
            Err(e) => return Err(AppError::from_io(e, "install the command")),
        }
        Ok(status())
    }

    pub fn uninstall(prompt: &str) -> AppResult<Option<bool>> {
        // Only a command this app wrote is removed, whichever copy of the app it starts.
        if fs::read_to_string(COMMAND).is_ok_and(|text| is_ours(&text)) {
            match fs::remove_file(COMMAND) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                    as_root(REMOVE, &[prompt])?;
                }
                Err(e) => return Err(AppError::from_io(e, "remove the command")),
            }
        }
        Ok(status())
    }

    /// An app bundle, and the name of its program in `Contents/MacOS`.
    struct Bundle {
        app: String,
        program: String,
    }

    /// The app bundle this process runs from, which the command starts. `None` for a
    /// build that is in no bundle (development), and for a downloaded app that macOS
    /// runs from a random read-only path until it is moved (App Translocation): that
    /// path does not last.
    fn bundle() -> Option<Bundle> {
        let exe = fs::canonicalize(std::env::current_exe().ok()?).ok()?;
        let macos = exe.parent()?;
        let app = macos.parent()?.parent()?;
        let bundled = macos.ends_with("Contents/MacOS")
            && app.extension().is_some_and(|ext| ext == "app")
            && !app
                .components()
                .any(|part| part.as_os_str() == "AppTranslocation");
        if !bundled {
            return None;
        }
        Some(Bundle {
            app: app.to_str()?.to_owned(),
            program: exe.file_name()?.to_str()?.to_owned(),
        })
    }

    fn script(bundle: &Bundle) -> String {
        let body = BODY
            .replace("@PROBE@", headless::PROBE)
            .replace("@EXE@", &quote(&bundle.program))
            .replace("@APP@", &quote(&bundle.app));
        format!("{HEAD}{body}")
    }

    /// `text` in single quotes, for `sh`.
    fn quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', r"'\''"))
    }

    fn is_ours(text: &str) -> bool {
        text.starts_with(HEAD)
    }

    /// The script is this app's, starts the bundle `app`, and asks its program
    /// about subcommands. The rest of it may be another version's, which works as
    /// well. One written before there were subcommands (PLAT-15) opens them as
    /// paths: it reads as not installed, and the switch writes it again.
    fn starts(text: &str, app: &str) -> bool {
        is_ours(text)
            && text.contains(&format!("\napp={}\n", quote(app)))
            && text.contains(headless::PROBE)
    }

    /// Writes the command as the user, replacing it in one step.
    fn write(script: &str) -> io::Result<()> {
        fs::create_dir_all(BIN_DIR)?;
        let temp = Path::new(BIN_DIR).join(format!(".mininote.{}", std::process::id()));
        let written = fs::write(&temp, script)
            .and_then(|()| fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)))
            .and_then(|()| fs::rename(&temp, COMMAND));
        if written.is_err() {
            let _ = fs::remove_file(&temp);
        }
        written
    }

    /// Writes the command as root, which copies it from a file in the user's own
    /// temporary folder: what root runs is fixed text and that file's path. The
    /// file is created new, so it is never a link somebody else left there.
    fn write_as_root(script: &str, prompt: &str) -> AppResult<()> {
        let staged = std::env::temp_dir().join(format!("mininote-command.{}", std::process::id()));
        let _ = fs::remove_file(&staged);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .and_then(|mut file| file.write_all(script.as_bytes()))
            .map_err(|e| AppError::from_io(e, "stage the command"))?;
        let done = match staged.to_str() {
            Some(path) => as_root(INSTALL, &[path, prompt]),
            None => Err(AppError::new(
                ErrorKind::InvalidPath,
                "the temporary folder is not valid UTF-8",
            )),
        };
        let _ = fs::remove_file(&staged);
        done
    }

    /// Runs one of the AppleScripts above, for which macOS asks an administrator's
    /// password. Declining is not an error: nothing was done.
    fn as_root(lines: &[&str], args: &[&str]) -> AppResult<()> {
        let mut osascript = Command::new("/usr/bin/osascript");
        for line in lines {
            osascript.arg("-e").arg(line);
        }
        // After `--` nothing is read as an option of osascript itself.
        let output = osascript
            .arg("--")
            .args(args)
            .output()
            .map_err(|e| AppError::from_io(e, "ask for an administrator"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        // -128 is AppleScript's "user canceled".
        if stderr.contains("(-128)") {
            return Ok(());
        }
        Err(AppError::new(
            ErrorKind::Io,
            format!("the administrator's command failed: {}", stderr.trim()),
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_script_names_its_app() {
            let bundle = Bundle {
                app: "/Applications/It's mine/Mininote.app".into(),
                program: "mininote".into(),
            };
            let text = script(&bundle);
            assert!(text.contains("\napp='/Applications/It'\\''s mine/Mininote.app'\n"));
            assert!(text.contains("\nbin=$app/Contents/MacOS/'mininote'\n"));
            assert!(text.contains("\"$bin\" --is-subcommand \"$1\""));
            assert!(
                !text.contains("@APP@") && !text.contains("@EXE@") && !text.contains("@PROBE@")
            );
            assert!(is_ours(&text) && starts(&text, &bundle.app));
            assert!(!starts(&text, "/Applications/Mininote.app"));
            // Another version's script counts when it asks about subcommands; one
            // from before them is still ours, to replace or remove. Another program
            // never is.
            let later = format!("{HEAD}app='/a.app'\n\"$app/x\" --is-subcommand \"$1\"\n");
            assert!(starts(&later, "/a.app"));
            let earlier = format!("{HEAD}app='/a.app'\nexit 0\n");
            assert!(is_ours(&earlier) && !starts(&earlier, "/a.app"));
            assert!(!is_ours("#!/bin/sh\nexec something-else \"$@\"\n"));
        }
    }
}

/// Windows and Linux: nothing to do here. A Linux package installs `mininote` into
/// the PATH itself, and on Windows that is the installer's work.
#[cfg(not(target_os = "macos"))]
mod shell {
    use crate::error::{AppError, AppResult, ErrorKind};

    pub fn status() -> Option<bool> {
        None
    }

    pub fn install(_prompt: &str) -> AppResult<Option<bool>> {
        Err(unsupported())
    }

    pub fn uninstall(_prompt: &str) -> AppResult<Option<bool>> {
        Err(unsupported())
    }

    fn unsupported() -> AppError {
        AppError::new(
            ErrorKind::Io,
            "the command is not installed by the app on this system",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mininote-cli-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn line(args: &[&str]) -> Vec<String> {
        std::iter::once("mininote")
            .chain(args.iter().copied())
            .map(str::to_owned)
            .collect()
    }

    fn target(vault: &Path, file: Option<&str>) -> Target {
        Target {
            vault: vault.to_str().unwrap().to_owned(),
            file: file.map(str::to_owned),
        }
    }

    #[test]
    fn a_folder_is_a_vault_and_a_file_opens_in_its_folder() {
        let root = scratch_dir("targets");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("a.md"), "a").unwrap();
        fs::write(sub.join("\u{BA54}\u{BAA8}.md"), "b").unwrap();
        fs::write(root.join("-odd.md"), "c").unwrap();

        // Relative to the folder the command ran in, or absolute.
        let (found, errors) = targets(&line(&[".", "sub/a.md"]), &root);
        assert!(errors.is_empty());
        assert_eq!(found, vec![target(&root, None), target(&sub, Some("a.md"))]);
        let absolute = sub.join("\u{BA54}\u{BAA8}.md");
        let (found, _) = targets(&line(&[absolute.to_str().unwrap()]), Path::new("/"));
        assert_eq!(found, vec![target(&sub, Some("\u{BA54}\u{BAA8}.md"))]);

        // One window per folder: the folder and its files are one target, with the file named last.
        let (found, _) = targets(
            &line(&["sub", "sub/a.md", "sub/\u{BA54}\u{BAA8}.md", "sub"]),
            &root,
        );
        assert_eq!(found, vec![target(&sub, Some("\u{BA54}\u{BAA8}.md"))]);

        // Options are skipped; after `--` everything is a path. What names nothing is reported.
        let (found, errors) = targets(&line(&["--wait", "-odd.md", "nothing.md"]), &root);
        assert!(found.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("nothing.md: "));
        let (found, errors) = targets(&line(&["--", "-odd.md"]), &root);
        assert!(errors.is_empty());
        assert_eq!(found, vec![target(&root, Some("-odd.md"))]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_stray_glob_opens_a_few_folders() {
        let root = scratch_dir("glob");
        let names: Vec<String> = (0..MAX_TARGETS + 4).map(|n| format!("d{n}")).collect();
        for name in &names {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let args: Vec<&str> = names.iter().map(String::as_str).collect();
        let (found, errors) = targets(&line(&args), &root);
        assert!(errors.is_empty());
        assert_eq!(found.len(), MAX_TARGETS);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_opens_in_its_own_folder() {
        let root = scratch_dir("link");
        let (here, elsewhere) = (root.join("here"), root.join("elsewhere"));
        fs::create_dir_all(&here).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("real.md"), "x").unwrap();
        std::os::unix::fs::symlink(elsewhere.join("real.md"), here.join("link.md")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, here.join("folder")).unwrap();

        let (found, _) = targets(&line(&["here/link.md"]), &root);
        assert_eq!(found, vec![target(&here, Some("link.md"))]);
        // A link to a folder is that folder: a vault's root is never a link.
        let (found, _) = targets(&line(&["here/folder"]), &root);
        assert_eq!(found, vec![target(&elsewhere, None)]);

        fs::remove_dir_all(&root).unwrap();
    }
}
