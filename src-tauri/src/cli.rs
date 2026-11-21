//! The command line (PLAT-14, ARCHITECTURE §6.9): the folders and files it names,
//! and the restart that repeats one.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager};

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
/// The command has no options: an argument that looks like one is skipped, and
/// after `--` every argument is a path.
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
