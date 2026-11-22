//! The subcommands of `mininote` (PLAT-15, ARCHITECTURE §6.10): `mininote vaults`,
//! `mininote read todo.md`, `mininote edit …`. A subcommand is answered by this
//! process alone, before there is an app: no window, no Tauri runtime. It works on
//! a vault's files with the functions the app's own commands use, prints where it
//! was typed, and exits. A running app hears of what it wrote from its watcher, as
//! of any other program's writes (§8.2).

use std::collections::HashMap;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, ErrorKind};
use crate::fs_ops::{self, Baseline, FileContent};
use crate::search;
use crate::store::{self, KnownVaults};
use crate::vault::{self, VaultState};

/// Asks whether the word after it is answered here: the terminal command (a
/// script on macOS, `cli::shell`) asks before it opens its arguments as paths, so
/// it never has to know the subcommands itself.
pub const PROBE: &str = "--is-subcommand";
/// The notes `search` lists when `--limit` does not say.
const SEARCH_LIMIT: u32 = 50;
/// Exit statuses: a subcommand that failed, and one that was not understood.
const FAILED: i32 = 1;
const MISUSED: i32 = 2;
/// The kind of a [`Failure`] that is a misuse of the command line.
const USAGE: &str = "usage";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verb {
    Vaults,
    Ls,
    Read,
    Create,
    Write,
    Append,
    Edit,
    Mkdir,
    Mv,
    Rm,
    Search,
}

/// One option of a subcommand.
struct Opt {
    /// `--name`, under which its value is kept.
    name: &'static str,
    /// Its one-letter form, or nothing.
    short: &'static str,
    /// What the help calls its value; nothing for a switch.
    value: &'static str,
    required: bool,
    about: &'static str,
}

const fn switch(name: &'static str, about: &'static str) -> Opt {
    Opt {
        name,
        short: "",
        value: "",
        required: false,
        about,
    }
}

const fn valued(
    name: &'static str,
    value: &'static str,
    required: bool,
    about: &'static str,
) -> Opt {
    Opt {
        name,
        short: "",
        value,
        required,
        about,
    }
}

/// One subcommand: its name is the first word of the command line.
struct Sub {
    verb: Verb,
    name: &'static str,
    /// Its arguments as the help shows them, and how many it takes: at least, at most.
    args: &'static str,
    takes: (usize, usize),
    /// What it does, in a line and in full.
    about: &'static str,
    more: &'static str,
    /// Its own options. Every subcommand also takes `--json`, and `--vault` when it
    /// works in a vault.
    options: &'static [Opt],
    in_vault: bool,
}

static VAULT: Opt = valued(
    "--vault",
    "<name|path>",
    false,
    "The vault, by its name or by its folder's path",
);
static JSON: Opt = switch("--json", "Print the answer, or the error, as JSON");
const TEXT: Opt = valued(
    "--text",
    "<text>",
    false,
    "The text; without it, what is piped in",
);

/// The subcommands, in the order the help lists them. A name here is a contract:
/// scripts and agents call it.
static SUBS: &[Sub] = &[
    Sub {
        verb: Verb::Vaults,
        name: "vaults",
        args: "",
        takes: (0, 0),
        about: "List the vaults Mininote knows",
        more: "Lists the folders Mininote has opened as vaults, the one opened last first:\n\
               the name and the path of each, with a tab between them.",
        options: &[],
        in_vault: false,
    },
    Sub {
        verb: Verb::Ls,
        name: "ls",
        args: "[<folder>]",
        takes: (0, 1),
        about: "List a folder of a vault",
        more: "Lists what <folder> holds, or the vault's own folder: a path on each line,\n\
               a folder's with a / at its end. Hidden files are left out, as in the app.",
        options: &[Opt {
            name: "--recursive",
            short: "-R",
            value: "",
            required: false,
            about: "List what its folders hold too, all the way down",
        }],
        in_vault: true,
    },
    Sub {
        verb: Verb::Read,
        name: "read",
        args: "<file>",
        takes: (1, 1),
        about: "Print a note",
        more: "Prints the text of a note, or of another text file of the vault.",
        options: &[],
        in_vault: true,
    },
    Sub {
        verb: Verb::Create,
        name: "create",
        args: "<note>",
        takes: (1, 1),
        about: "Write a new note",
        more: "Writes a new note with the text, or an empty one, and the folders its path\n\
               names. Fails when the path is taken.",
        options: &[TEXT],
        in_vault: true,
    },
    Sub {
        verb: Verb::Write,
        name: "write",
        args: "<note>",
        takes: (1, 1),
        about: "Replace the text of a note",
        more: "Replaces the whole text of a note, or creates the note. Nothing piped in is\n\
               a mistake, not an empty note: --text '' empties one.",
        options: &[TEXT],
        in_vault: true,
    },
    Sub {
        verb: Verb::Append,
        name: "append",
        args: "<note>",
        takes: (1, 1),
        about: "Add text to the end of a note",
        more: "Adds the text after the last line of a note, or creates the note.",
        options: &[TEXT],
        in_vault: true,
    },
    Sub {
        verb: Verb::Edit,
        name: "edit",
        args: "<note>",
        takes: (1, 1),
        about: "Replace a piece of a note's text",
        more: "Puts the text of --new where the text of --old is. The note must have that\n\
               text exactly once, unless --all replaces it everywhere.",
        options: &[
            valued("--old", "<text>", true, "The text to replace"),
            valued(
                "--new",
                "<text>",
                true,
                "The text to put there; '' removes it",
            ),
            switch("--all", "Replace it wherever it is"),
        ],
        in_vault: true,
    },
    Sub {
        verb: Verb::Mkdir,
        name: "mkdir",
        args: "<folder>",
        takes: (1, 1),
        about: "Create a folder",
        more: "Creates a folder, and the folders its path names. Fails when the path is taken.",
        options: &[],
        in_vault: true,
    },
    Sub {
        verb: Verb::Mv,
        name: "mv",
        args: "<from> <to>",
        takes: (2, 2),
        about: "Rename or move a file or a folder",
        more: "Gives a file or a folder the path <to>, whose folders are created: <to> is\n\
               the new path itself, not a folder to move into. Fails when it is taken.",
        options: &[],
        in_vault: true,
    },
    Sub {
        verb: Verb::Rm,
        name: "rm",
        args: "<path>",
        takes: (1, 1),
        about: "Move a file or a folder to the trash",
        more: "Moves a file, or a folder with all it holds, to the system's trash.",
        options: &[switch("--permanent", "Delete it for good instead")],
        in_vault: true,
    },
    Sub {
        verb: Verb::Search,
        name: "search",
        args: "<word> ...",
        takes: (1, usize::MAX),
        about: "Find notes by their text and name",
        more: "Lists the notes that have every word in their text or their name, and the\n\
               lines the words are on, as path:line:text. '\"Words in quotes\"' are found as\n\
               they stand.",
        options: &[
            switch("--case-sensitive", "Tell A from a"),
            valued("--limit", "<n>", false, "List this many notes at most (50)"),
        ],
        in_vault: true,
    },
];

impl Opt {
    /// `--name <value>`.
    fn shown(&self) -> String {
        if self.value.is_empty() {
            self.name.to_owned()
        } else {
            format!("{} {}", self.name, self.value)
        }
    }
}

impl Sub {
    fn all_options(&self) -> impl Iterator<Item = &'static Opt> {
        let vault: Option<&'static Opt> = self.in_vault.then_some(&VAULT);
        self.options.iter().chain(vault).chain([&JSON])
    }

    fn option(&self, word: &str) -> Option<&'static Opt> {
        self.all_options()
            .find(|opt| opt.name == word || (!opt.short.is_empty() && opt.short == word))
    }

    /// `usage: mininote edit <note> --old <text> --new <text> [--all] …`.
    fn usage(&self) -> String {
        let mut line = format!("usage: mininote {}", self.name);
        if !self.args.is_empty() {
            line.push(' ');
            line.push_str(self.args);
        }
        for opt in self.all_options() {
            if opt.required {
                line.push_str(&format!(" {}", opt.shown()));
            } else {
                line.push_str(&format!(" [{}]", opt.shown()));
            }
        }
        line
    }

    fn help(&self) -> String {
        let mut text = format!("{}\n\n{}\n\n", self.usage(), self.more);
        for opt in self.all_options() {
            text.push_str(&option_line(opt.short, &opt.shown(), opt.about));
        }
        text.push_str(&option_line("-h", "--help", "Explain this command"));
        text
    }
}

fn option_line(short: &str, shown: &str, about: &str) -> String {
    let short = if short.is_empty() {
        "    ".to_owned()
    } else {
        format!("{short}, ")
    };
    format!("  {short}{shown:<22}{about}\n")
}

fn sub_named(word: &str) -> Option<&'static Sub> {
    SUBS.iter().find(|sub| sub.name == word)
}

fn asks_help(word: &str) -> bool {
    word == "-h" || word == "--help"
}

fn asks_version(word: &str) -> bool {
    word == "-V" || word == "--version"
}

/// Whether a command line that begins with `word` is answered here. Any other
/// names folders and files for the app to show (`cli::targets`).
fn answers(word: &str) -> bool {
    sub_named(word).is_some() || asks_help(word) || asks_version(word)
}

fn general_help() -> String {
    let mut text = String::from(
        "usage: mininote [<path> ...]\n\
         \x20      mininote <command> [<option> ...] [<argument> ...]\n\
         \n\
         Without a command, Mininote opens each folder, and each file in its folder.\n\
         A command works on the files of a vault from here, and opens no window:\n\
         \n",
    );
    for sub in SUBS {
        let shown = format!("{} {}", sub.name, sub.args);
        text.push_str(&format!("  {shown:<20}{}\n", sub.about));
    }
    text.push_str("\nOptions:\n\n");
    for opt in [&VAULT, &JSON] {
        text.push_str(&option_line(opt.short, &opt.shown(), opt.about));
    }
    text.push_str(&option_line("-h", "--help", "Explain the command"));
    text.push_str(&option_line("-V", "--version", "Print the version"));
    text.push_str(
        "\n\
         A command works in the vault that --vault names: by a name that\n\
         `mininote vaults` lists, or by the path of any folder. Without --vault, that is\n\
         the vault the folder it runs in belongs to, else the vault Mininote opened last.\n\
         A path is relative to the vault's folder, and spelled as `mininote ls` prints it.\n\
         \n\
         A folder or a file named like a command opens as a path: mininote ./ls\n",
    );
    text
}

/// What went wrong, for the terminal and for a program (`--json`). The kinds are
/// those of the app's own errors (`IpcErrorKind` in src/lib/types.ts), plus
/// `usage`, and `no_match` and `ambiguous` for `edit`.
#[derive(Debug)]
struct Failure {
    kind: String,
    message: String,
}

fn failure(kind: &str, message: impl Into<String>) -> Failure {
    Failure {
        kind: kind.to_owned(),
        message: message.into(),
    }
}

fn usage(message: impl Into<String>) -> Failure {
    failure(USAGE, message)
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        // The kind's name is the one it crosses IPC under.
        let kind = match serde_json::to_value(error.kind) {
            Ok(Value::String(kind)) => kind,
            _ => "io".to_owned(),
        };
        Self {
            kind,
            message: error.message,
        }
    }
}

/// What a subcommand answers: the text for a terminal, the same as JSON for a
/// program, and a remark for standard error.
#[derive(Debug, Default)]
struct Done {
    text: String,
    json: Option<Value>,
    remark: Option<String>,
}

/// The answer of a subcommand that prints nothing in a terminal.
fn quiet(json: Value) -> Done {
    Done {
        json: Some(json),
        ..Default::default()
    }
}

/// Where a subcommand runs.
struct Env<'a> {
    cwd: PathBuf,
    /// The app config folder, where the settings are.
    config: Option<PathBuf>,
    /// What is piped in, read when a subcommand takes its text from there; `None`
    /// when standard input is a terminal.
    piped: &'a mut dyn FnMut() -> io::Result<Option<Vec<u8>>>,
}

/// Answers the command line if it begins with a subcommand, `--help` or
/// `--version`, and exits. Returns when it does not: the app starts, and shows
/// the folders and files the line names (`cli::launch`).
pub fn answer() {
    let mut args = std::env::args_os().skip(1).map(|arg| arg.into_string());
    let Some(Ok(first)) = args.next() else {
        return;
    };
    if first == PROBE {
        let answered = matches!(args.next(), Some(Ok(word)) if answers(&word));
        std::process::exit(if answered { 0 } else { FAILED });
    }
    if !answers(&first) {
        return;
    }
    let (stdout, stderr) = (io::stdout(), io::stderr());
    let (mut out, mut err) = (stdout.lock(), stderr.lock());
    let mut words = vec![first];
    for arg in args {
        match arg {
            Ok(word) => words.push(word),
            Err(_) => {
                let _ = writeln!(err, "mininote: an argument is not valid UTF-8");
                std::process::exit(MISUSED);
            }
        }
    }
    let mut piped = piped_input;
    let mut env = Env {
        cwd: std::env::current_dir().unwrap_or_default(),
        config: store::config_dir_alone(),
        piped: &mut piped,
    };
    let code = run(&words, &mut env, &mut out, &mut err);
    std::process::exit(code);
}

/// Standard input, unless it is a terminal: nobody is asked to type a note.
fn piped_input() -> io::Result<Option<Vec<u8>>> {
    let stdin = io::stdin();
    if stdin.is_terminal() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    stdin
        .lock()
        .take(fs_ops::MAX_NOTE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// Runs the command line `words` (the program's name left out), prints its answer
/// on `out` or its failure on `err`, and returns the exit status. Nothing here may
/// panic on a closed pipe, so nothing is printed with `println!`.
fn run(words: &[String], env: &mut Env, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let as_json = words
        .iter()
        .take_while(|word| *word != "--")
        .any(|word| word == JSON.name);
    let sub = words.first().and_then(|word| sub_named(word));
    let done = match (sub, words.first()) {
        (Some(sub), _) => execute(sub, &words[1..], env),
        (None, Some(word)) if asks_version(word) => Ok(Done {
            text: format!("mininote {}\n", env!("CARGO_PKG_VERSION")),
            ..Default::default()
        }),
        _ => Ok(Done {
            text: general_help(),
            ..Default::default()
        }),
    };
    match done {
        Ok(done) => {
            if let Some(remark) = &done.remark {
                let _ = writeln!(err, "mininote: {remark}");
            }
            let body = match &done.json {
                Some(json) if as_json => format!("{json}\n"),
                _ => done.text,
            };
            match out.write_all(body.as_bytes()).and_then(|()| out.flush()) {
                // The reader has what it wanted (`mininote ls | head`).
                Err(e) if e.kind() != io::ErrorKind::BrokenPipe => {
                    let _ = writeln!(err, "mininote: {e}");
                    FAILED
                }
                _ => 0,
            }
        }
        Err(failure) => {
            let misused = failure.kind == USAGE;
            if as_json {
                let report =
                    json!({ "error": { "kind": failure.kind, "message": failure.message } });
                let _ = writeln!(err, "{report}");
            } else {
                let _ = writeln!(err, "mininote: {}", failure.message);
                if let (true, Some(sub)) = (misused, sub) {
                    let _ = writeln!(err, "{}", sub.usage());
                }
            }
            if misused {
                MISUSED
            } else {
                FAILED
            }
        }
    }
}

fn execute(sub: &'static Sub, words: &[String], env: &mut Env) -> Result<Done, Failure> {
    let Some(args) = parse(sub, words)? else {
        return Ok(Done {
            text: sub.help(),
            ..Default::default()
        });
    };
    let known = env
        .config
        .as_deref()
        .map(store::known_vaults)
        .unwrap_or_default();
    let cwd = env.cwd.clone();
    let root = || vault_root(args.value(VAULT.name), &known, &cwd);
    // Nothing watches for this process: its record of what it wrote is never read.
    let state = VaultState::new();
    match sub.verb {
        Verb::Vaults => Ok(vaults(&known)),
        Verb::Ls => list(&root()?, &args),
        Verb::Read => read(&root()?, &args),
        Verb::Create => create(&state, &root()?, &args, env),
        Verb::Write => write(&state, &root()?, &args, env),
        Verb::Append => append(&state, &root()?, &args, env),
        Verb::Edit => edit(&state, &root()?, &args),
        Verb::Mkdir => mkdir(&state, &root()?, &args),
        Verb::Mv => mv(&state, &root()?, &args),
        Verb::Rm => rm(&root()?, &args),
        Verb::Search => find(&root()?, &args),
    }
}

// ---------------------------------------------------------------- the command line

/// What a subcommand was given.
#[derive(Debug, Default, PartialEq)]
struct Args {
    /// Its switches, and its options with their value, by `--name`.
    switches: Vec<&'static str>,
    values: HashMap<&'static str, String>,
    /// Its other arguments, in order.
    rest: Vec<String>,
}

impl Args {
    fn has(&self, name: &str) -> bool {
        self.switches.contains(&name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
}

/// Reads a subcommand's words the way `getopt_long` does: options anywhere, a
/// value in the next word or after `=`, and after `--` every word is an argument,
/// as is a lone `-`. An option's value is taken as it is, so `--text "- item"`
/// works. `None` when the words ask for help.
fn parse(sub: &'static Sub, words: &[String]) -> Result<Option<Args>, Failure> {
    let mut args = Args::default();
    let mut options = true;
    let mut words = words.iter();
    while let Some(word) = words.next() {
        if !options || word == "-" || !word.starts_with('-') {
            args.rest.push(word.clone());
            continue;
        }
        if word == "--" {
            options = false;
            continue;
        }
        if asks_help(word) {
            return Ok(None);
        }
        let (name, inline) = match word.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (word.as_str(), None),
        };
        let opt = sub
            .option(name)
            .ok_or_else(|| usage(format!("unknown option: {name}")))?;
        match (opt.value.is_empty(), inline) {
            (true, None) => args.switches.push(opt.name),
            (true, Some(_)) => return Err(usage(format!("{} takes no value", opt.name))),
            (false, Some(value)) => {
                args.values.insert(opt.name, value.to_owned());
            }
            (false, None) => {
                let value = words
                    .next()
                    .ok_or_else(|| usage(format!("{} needs a value", opt.name)))?;
                args.values.insert(opt.name, value.clone());
            }
        }
    }
    let (least, most) = sub.takes;
    if args.rest.len() < least {
        return Err(usage(format!("{}: an argument is missing", sub.name)));
    }
    if let Some(extra) = args.rest.get(most) {
        return Err(usage(format!("{}: unexpected argument: {extra}", sub.name)));
    }
    if let Some(missing) = sub
        .all_options()
        .find(|opt| opt.required && !args.values.contains_key(opt.name))
    {
        return Err(usage(format!("{} is missing", missing.name)));
    }
    Ok(Some(args))
}

// ---------------------------------------------------------------- vaults

/// A vault's name: its folder's.
fn vault_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_owned()
}

/// A name as it is compared: in NFC, whatever its case.
fn fold(name: &str) -> String {
    name.nfc().flat_map(char::to_lowercase).collect()
}

/// `mininote vaults`: the vaults the settings remember, the one opened last first.
fn vaults(known: &KnownVaults) -> Done {
    let mut text = String::new();
    let mut rows = Vec::new();
    for path in &known.recent {
        let name = vault_name(path);
        text.push_str(&format!("{name}\t{path}\n"));
        rows.push(json!({ "name": name, "path": path, "available": Path::new(path).is_dir() }));
    }
    Done {
        text,
        json: Some(Value::Array(rows)),
        remark: None,
    }
}

/// The folder a subcommand works in (PLAT-15). `--vault` names it: a path when it
/// has a separator (or is `.` or `..`), read from `cwd`, and any folder will do;
/// otherwise the name of a vault the app knows. Without `--vault` it is the known
/// vault `cwd` is in (the innermost), else the vault opened last.
fn vault_root(choice: Option<&str>, known: &KnownVaults, cwd: &Path) -> Result<PathBuf, Failure> {
    let no_vault = |message: String| Failure::from(AppError::new(ErrorKind::NoVault, message));
    let folder = match choice {
        Some(path) if names_a_path(path) => cwd.join(path),
        Some(name) => {
            let wanted = fold(name);
            let named: Vec<&str> = known
                .recent
                .iter()
                .map(String::as_str)
                .filter(|path| fold(&vault_name(path)) == wanted)
                .collect();
            match named.as_slice() {
                [one] => PathBuf::from(one),
                [] => {
                    return Err(no_vault(format!(
                        "no vault is named {name}: `mininote vaults` lists them, and a folder is given by its path (./{name})"
                    )))
                }
                several => {
                    return Err(no_vault(format!(
                        "several vaults are named {name}, give the path of one: {}",
                        several.join(", ")
                    )))
                }
            }
        }
        None => {
            let here = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
            known
                .recent
                .iter()
                .map(Path::new)
                .filter(|vault| here.starts_with(vault))
                .max_by_key(|vault| vault.components().count())
                .or(known.last.as_deref().map(Path::new))
                .or(known.recent.first().map(Path::new))
                .map(Path::to_path_buf)
                .ok_or_else(|| {
                    no_vault("no vault: name one with --vault, or give a folder's path".into())
                })?
        }
    };
    // The folder as `vault_open` names it. One that is not there is never created.
    match dunce::canonicalize(&folder) {
        Ok(root) if root.is_dir() => Ok(root),
        _ => Err(AppError::new(
            ErrorKind::RootUnavailable,
            format!("the vault folder is not available: {}", folder.display()),
        )
        .into()),
    }
}

fn names_a_path(choice: &str) -> bool {
    choice == "."
        || choice == ".."
        || choice.contains('/')
        || (cfg!(windows) && choice.contains('\\'))
        || Path::new(choice).is_absolute()
}

// ---------------------------------------------------------------- paths

fn invalid(message: String) -> Failure {
    AppError::new(ErrorKind::InvalidPath, message).into()
}

/// The `VaultPath` an argument names: relative to the vault's folder, as `ls`
/// prints it (a folder's `/` at the end included), `./` in front allowed. `""` is
/// the vault's folder. Hidden names are refused: the app shows none (TREE-01), and
/// a subcommand reaches what the app shows, so `.git` and `.obsidian` stay as they
/// are.
fn vault_path(arg: &str) -> Result<String, Failure> {
    if Path::new(arg).is_absolute() {
        return Err(invalid(format!(
            "{arg}: a path is relative to the vault's folder"
        )));
    }
    let rel = arg.strip_prefix("./").unwrap_or(arg).trim_end_matches('/');
    let rel = if rel == "." { "" } else { rel };
    if vault::split_rel(rel)?
        .iter()
        .any(|part| part.starts_with('.'))
    {
        return Err(invalid(format!(
            "{rel}: a name that starts with a dot is hidden, and left alone"
        )));
    }
    Ok(rel.to_owned())
}

/// [`vault_path`] of a file or a folder in the vault, never the vault's own folder.
fn entry_path(arg: &str) -> Result<String, Failure> {
    let rel = vault_path(arg)?;
    if rel.is_empty() {
        return Err(invalid("name a file or a folder of the vault".into()));
    }
    Ok(rel)
}

/// [`entry_path`] of a note. Only notes are written: the app writes no other file
/// (TREE-17), and neither does its command.
fn note_path(arg: &str) -> Result<String, Failure> {
    let rel = entry_path(arg)?;
    let name = rel.rsplit('/').next().unwrap_or(&rel);
    if !fs_ops::is_note_name(name) {
        return Err(invalid(format!(
            "{rel}: not a note (a note's name ends in .md or .markdown)"
        )));
    }
    Ok(rel)
}

// ---------------------------------------------------------------- reading

/// `mininote ls`: the entries of a folder as `vault_list` gives them (§6.3), a
/// folder before what it holds.
fn list(root: &Path, args: &Args) -> Result<Done, Failure> {
    let folder = vault_path(args.rest.first().map_or("", String::as_str))?;
    let listing = fs_ops::list_vault(root, fs_ops::MAX_ENTRIES)?;
    let is_folder = |i: usize| listing.kinds.as_bytes().get(i) == Some(&b'd');
    if !folder.is_empty() {
        match listing.paths.iter().position(|path| *path == folder) {
            Some(i) if is_folder(i) => {}
            Some(_) => return Err(invalid(format!("not a folder: {folder}"))),
            None => {
                return Err(
                    AppError::new(ErrorKind::NotFound, format!("not found: {folder}")).into(),
                )
            }
        }
    }
    let recursive = args.has("--recursive");
    let mut shown: Vec<usize> = (0..listing.paths.len())
        .filter(|&i| is_within(&listing.paths[i], &folder, recursive))
        .collect();
    shown.sort_by(|&a, &b| listing.paths[a].split('/').cmp(listing.paths[b].split('/')));
    let mut text = String::new();
    let mut rows = Vec::with_capacity(shown.len());
    for i in shown {
        let path = &listing.paths[i];
        text.push_str(path);
        if is_folder(i) {
            text.push('/');
            rows.push(json!({ "path": path, "type": "folder" }));
        } else {
            // The listing stats notes and images only (§6.3).
            match listing.mtimes.get(i) {
                Some(&mtime) if mtime > 0 => {
                    rows.push(json!({ "path": path, "type": "file", "mtime": mtime }));
                }
                _ => rows.push(json!({ "path": path, "type": "file" })),
            }
        }
        text.push('\n');
    }
    Ok(Done {
        text,
        json: Some(Value::Array(rows)),
        remark: listing.truncated.then(|| {
            format!(
                "the vault has more than {} entries: not all are listed",
                fs_ops::MAX_ENTRIES
            )
        }),
    })
}

/// Whether `path` is in `folder` (`""`: the vault's): right in it, or anywhere
/// below it when `recursive`.
fn is_within(path: &str, folder: &str, recursive: bool) -> bool {
    let below = if folder.is_empty() {
        Some(path)
    } else {
        path.strip_prefix(folder)
            .and_then(|rest| rest.strip_prefix('/'))
    };
    below.is_some_and(|rest| recursive || !rest.contains('/'))
}

/// `mininote read`: a note's text as `note_read` gives it.
fn read(root: &Path, args: &Args) -> Result<Done, Failure> {
    let rel = entry_path(&args.rest[0])?;
    let abs = vault::resolve(root, &rel)?;
    let file = fs_ops::read_note(&abs, &rel)?;
    let json = json!({
        "path": rel,
        "content": file.content,
        "bom": file.bom,
        "readOnly": file.read_only,
        "created": file.created,
        "mtime": file.mtime,
        "size": file.size,
        "hash": file.hash,
    });
    Ok(Done {
        text: file.content,
        json: Some(json),
        remark: None,
    })
}

/// `mininote search`: the notes `search_text` finds (§6.5), with lines counted
/// from 1, as `grep -n` counts them.
fn find(root: &Path, args: &Args) -> Result<Done, Failure> {
    let limit = match args.value("--limit") {
        None => SEARCH_LIMIT,
        Some(given) => given
            .parse::<u32>()
            .ok()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| usage("--limit takes a number above 0"))?,
    };
    let found = search::search_vault(
        root,
        &args.rest.join(" "),
        args.has("--case-sensitive"),
        limit.min(search::MAX_LIMIT) as usize,
        &|| false,
    );
    let mut text = String::new();
    let mut rows = Vec::with_capacity(found.results.len());
    for result in &found.results {
        // A note found by its name alone has no line to show.
        if result.matches.is_empty() {
            text.push_str(&format!("{}\n", result.path));
        }
        let mut lines = Vec::with_capacity(result.matches.len());
        for hit in &result.matches {
            let line = hit.line + 1;
            text.push_str(&format!("{}:{line}:{}\n", result.path, hit.text));
            lines.push(json!({ "line": line, "text": hit.text }));
        }
        rows.push(json!({ "path": result.path, "nameMatch": result.name_match, "matches": lines }));
    }
    Ok(Done {
        text,
        json: Some(json!({ "results": rows, "truncated": found.truncated })),
        remark: found
            .truncated
            .then(|| "more notes match than are listed (--limit)".to_owned()),
    })
}

// ---------------------------------------------------------------- writing

/// The text a subcommand writes: `--text` as it is, else what is piped in. `None`
/// when there is neither, and for an empty pipe: a forgotten pipe never empties a
/// note.
fn given_text(args: &Args, env: &mut Env) -> Result<Option<String>, Failure> {
    if let Some(text) = args.value(TEXT.name) {
        return Ok(Some(text.to_owned()));
    }
    let piped =
        (env.piped)().map_err(|e| Failure::from(AppError::from_io(e, "read standard input")))?;
    match piped {
        Some(bytes) if !bytes.is_empty() => String::from_utf8(bytes).map(Some).map_err(|_| {
            AppError::new(ErrorKind::NotUtf8, "the text piped in is not UTF-8").into()
        }),
        _ => Ok(None),
    }
}

fn no_text() -> Failure {
    usage("no text: pipe it in, or give it with --text")
}

/// Writes a note's bytes as `note_write` does (§6.2). With `expected`, the note
/// must still be as it was read: another program's write in between is `conflict`.
fn save(
    state: &VaultState,
    root: &Path,
    rel: &str,
    bytes: &[u8],
    expected: Option<&Baseline>,
) -> Result<Baseline, Failure> {
    if bytes.len() as u64 > fs_ops::MAX_NOTE_BYTES {
        return Err(AppError::new(ErrorKind::TooLarge, format!("larger than 20 MB: {rel}")).into());
    }
    let abs = vault::resolve(root, rel)?;
    Ok(fs_ops::write_note(state, root, &abs, rel, bytes, expected)?)
}

fn saved(rel: &str, baseline: &Baseline) -> Value {
    json!({ "path": rel, "mtime": baseline.mtime, "size": baseline.size, "hash": baseline.hash })
}

/// `mininote create`: a new note, as `note_create` makes one.
fn create(state: &VaultState, root: &Path, args: &Args, env: &mut Env) -> Result<Done, Failure> {
    let rel = note_path(&args.rest[0])?;
    let text = given_text(args, env)?.unwrap_or_default();
    let baseline = fs_ops::create_note(state, root, &rel, text.as_bytes())?;
    Ok(quiet(saved(&rel, &baseline)))
}

/// `mininote write`: the text as it was given becomes the note.
fn write(state: &VaultState, root: &Path, args: &Args, env: &mut Env) -> Result<Done, Failure> {
    let rel = note_path(&args.rest[0])?;
    let text = given_text(args, env)?.ok_or_else(no_text)?;
    let baseline = save(state, root, &rel, text.as_bytes(), None)?;
    Ok(quiet(saved(&rel, &baseline)))
}

/// `mininote append`: the text goes after the note's last line.
fn append(state: &VaultState, root: &Path, args: &Args, env: &mut Env) -> Result<Done, Failure> {
    let rel = note_path(&args.rest[0])?;
    let text = given_text(args, env)?.ok_or_else(no_text)?;
    let abs = vault::resolve(root, &rel)?;
    let baseline = match fs_ops::read_note(&abs, &rel) {
        // No text is no change, not a line break of its own.
        Ok(file) if text.is_empty() => Opened::from(file).baseline,
        Ok(file) => {
            let note = Opened::from(file);
            let whole = appended(&note.text, &to_lf(&text));
            save(state, root, &rel, &note.bytes(&whole), Some(&note.baseline))?
        }
        Err(e) if e.kind == ErrorKind::NotFound => save(state, root, &rel, text.as_bytes(), None)?,
        Err(e) => return Err(e.into()),
    };
    Ok(quiet(saved(&rel, &baseline)))
}

/// `mininote edit`: one piece of the note's text is replaced, or every one of them
/// with `--all`. Line breaks are compared as the editor holds them, so a piece
/// that spans lines is found in a note with CRLF too.
fn edit(state: &VaultState, root: &Path, args: &Args) -> Result<Done, Failure> {
    let rel = note_path(&args.rest[0])?;
    let old = to_lf(args.value("--old").unwrap_or_default());
    let new = to_lf(args.value("--new").unwrap_or_default());
    if old.is_empty() {
        return Err(usage("--old is empty"));
    }
    let abs = vault::resolve(root, &rel)?;
    let note = Opened::from(fs_ops::read_note(&abs, &rel)?);
    let replaced = note.text.matches(old.as_str()).count();
    if replaced == 0 {
        return Err(failure(
            "no_match",
            format!("the text of --old is not in {rel}"),
        ));
    }
    if replaced > 1 && !args.has("--all") {
        return Err(failure(
            "ambiguous",
            format!("the text of --old is in {rel} {replaced} times: give more of it, or --all"),
        ));
    }
    let whole = note.text.replace(old.as_str(), &new);
    let baseline = if whole == note.text {
        note.baseline.clone()
    } else {
        save(state, root, &rel, &note.bytes(&whole), Some(&note.baseline))?
    };
    let mut json = saved(&rel, &baseline);
    json["replaced"] = json!(replaced);
    Ok(quiet(json))
}

/// A note as the editor holds it: its text with LF line breaks, and what a save
/// gives back to the file, its own line break and byte-order mark (EDIT-02,
/// `state/lineEndings.ts`). `append` and `edit` change that text, so a note keeps
/// its style through them as through a save in the app.
struct Opened {
    text: String,
    line_break: &'static str,
    bom: bool,
    /// The file as it was read: what it must still be when it is replaced.
    baseline: Baseline,
}

impl From<FileContent> for Opened {
    fn from(file: FileContent) -> Self {
        Self {
            line_break: line_break(&file.content),
            text: to_lf(&file.content),
            bom: file.bom,
            baseline: Baseline {
                mtime: file.mtime,
                size: file.size,
                hash: file.hash,
            },
        }
    }
}

impl Opened {
    /// The bytes of the file when its text is `text` (LF).
    fn bytes(&self, text: &str) -> Vec<u8> {
        let mut out = String::with_capacity(text.len() + 3);
        if self.bom {
            out.push('\u{FEFF}');
        }
        if self.line_break == "\n" {
            out.push_str(text);
        } else {
            out.push_str(&text.replace('\n', self.line_break));
        }
        out.into_bytes()
    }
}

/// The first line break of `text` (`detectLineEnding`); LF when it has none.
fn line_break(text: &str) -> &'static str {
    match text.find(['\r', '\n']) {
        Some(at) if text[at..].starts_with("\r\n") => "\r\n",
        Some(at) if text[at..].starts_with('\r') => "\r",
        _ => "\n",
    }
}

/// Every CRLF and lone CR as LF (`toLF`).
fn to_lf(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_owned()
    }
}

/// `text` with `more` after its last line: on a line of its own.
fn appended(text: &str, more: &str) -> String {
    let mut whole = String::with_capacity(text.len() + more.len() + 1);
    whole.push_str(text);
    if !text.is_empty() && !text.ends_with('\n') {
        whole.push('\n');
    }
    whole.push_str(more);
    whole
}

/// `mininote mkdir`: a folder, as `dir_create` makes one.
fn mkdir(state: &VaultState, root: &Path, args: &Args) -> Result<Done, Failure> {
    let rel = entry_path(&args.rest[0])?;
    fs_ops::create_dir(state, root, &rel)?;
    Ok(quiet(json!({ "path": rel })))
}

/// `mininote mv`: a new path for a file or a folder, as `path_rename` gives one.
fn mv(state: &VaultState, root: &Path, args: &Args) -> Result<Done, Failure> {
    let from = entry_path(&args.rest[0])?;
    let to = entry_path(&args.rest[1])?;
    fs_ops::rename_entry(state, root, &from, &to)?;
    Ok(quiet(json!({ "from": from, "to": to })))
}

/// `mininote rm`: into the trash as `path_trash` does it, or gone for good as
/// `path_delete` does it.
fn rm(root: &Path, args: &Args) -> Result<Done, Failure> {
    let rel = entry_path(&args.rest[0])?;
    let permanent = args.has("--permanent");
    if permanent {
        fs_ops::delete_entry(root, &rel)?;
    } else {
        fs_ops::trash_entry(root, &rel)?;
    }
    Ok(quiet(json!({ "path": rel, "trashed": !permanent })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn words(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_owned).collect()
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mininote-sub-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    /// Runs `line` in the vault `root` with `piped` on standard input: the exit
    /// status, and what went to standard output and standard error.
    fn run_in(root: &Path, line: &[&str], piped: Option<&str>) -> (i32, String, String) {
        let mut words: Vec<String> = line.iter().map(|word| (*word).to_owned()).collect();
        words.extend(["--vault".to_owned(), format!("{}/", root.display())]);
        let mut input = || Ok(piped.map(|text| text.as_bytes().to_vec()));
        let mut env = Env {
            cwd: root.to_path_buf(),
            config: None,
            piped: &mut input,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&words, &mut env, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn the_first_word_decides() {
        for word in [
            "vaults",
            "ls",
            "edit",
            "search",
            "-h",
            "--help",
            "-V",
            "--version",
        ] {
            assert!(answers(word), "{word}");
        }
        // Anything else is a path for the app, a relative one named like a subcommand too.
        for word in ["notes", "./ls", "LS", "--", "--json", "list", ""] {
            assert!(!answers(word), "{word}");
        }
        assert!(general_help().contains("  mv <from> <to>"));
    }

    #[test]
    fn options_are_read_as_getopt_reads_them() {
        let edit = sub_named("edit").unwrap();
        let args = parse(
            edit,
            &words("--old=a=b a.md --new -x --all --vault notes --json"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(args.rest, ["a.md"]);
        assert_eq!(args.value("--old"), Some("a=b"));
        // A value is taken as it is, a leading dash included.
        assert_eq!(args.value("--new"), Some("-x"));
        assert_eq!(args.value("--vault"), Some("notes"));
        assert!(args.has("--all") && args.has("--json"));

        let ls = sub_named("ls").unwrap();
        let args = parse(ls, &words("-R -- -odd")).unwrap().unwrap();
        assert!(args.has("--recursive"));
        assert_eq!(args.rest, ["-odd"]);
        assert!(parse(ls, &words("a --help")).unwrap().is_none());

        let misuse = |sub: &'static Sub, line: &str| parse(sub, &words(line)).unwrap_err().message;
        assert_eq!(misuse(ls, "--all"), "unknown option: --all");
        assert_eq!(misuse(ls, "a b"), "ls: unexpected argument: b");
        assert_eq!(misuse(ls, "--recursive=yes"), "--recursive takes no value");
        assert_eq!(misuse(ls, "--vault"), "--vault needs a value");
        assert_eq!(misuse(edit, "a.md --old x"), "--new is missing");
        assert_eq!(
            misuse(edit, "--old x --new y"),
            "edit: an argument is missing"
        );
        // `vaults` works in no vault.
        assert!(parse(sub_named("vaults").unwrap(), &words("--vault x")).is_err());
    }

    #[test]
    fn a_vault_is_named_or_found_from_the_folder() {
        let base = scratch_dir("vaults");
        let path = |rel: &str| {
            fs::create_dir_all(base.join(rel)).unwrap();
            base.join(rel).to_str().unwrap().to_owned()
        };
        let (notes, work, other) = (path("a/Notes"), path("work"), path("b/notes"));
        path("a/Notes/sub");
        path("free");
        let known = KnownVaults {
            recent: vec![work.clone(), notes.clone()],
            last: Some(work.clone()),
        };
        let root = |choice: Option<&str>, cwd: &str| {
            vault_root(choice, &known, &base.join(cwd))
                .map(|root| root.to_str().unwrap().to_owned())
        };
        // By name, whatever its case; by path, known or not.
        assert_eq!(root(Some("notes"), "free").unwrap(), notes);
        assert_eq!(root(Some("./free"), "").unwrap(), path("free"));
        assert_eq!(root(Some("."), "b/notes").unwrap(), other);
        assert_eq!(root(Some("free"), "").unwrap_err().kind, "no_vault");
        assert_eq!(
            root(Some("./gone"), "").unwrap_err().kind,
            "root_unavailable"
        );
        // Without a name: the vault the folder is in, else the one opened last.
        assert_eq!(root(None, "a/Notes/sub").unwrap(), notes);
        assert_eq!(root(None, "free").unwrap(), work);

        let twice = KnownVaults {
            recent: vec![notes.clone(), other],
            last: None,
        };
        let error = vault_root(Some("NOTES"), &twice, &base).unwrap_err();
        assert!(error.message.contains(&notes), "{}", error.message);
        let none = KnownVaults::default();
        assert_eq!(vault_root(None, &none, &base).unwrap_err().kind, "no_vault");

        let listed = vaults(&known);
        assert_eq!(listed.text, format!("work\t{work}\nNotes\t{notes}\n"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn paths_stay_in_what_the_app_shows() {
        assert_eq!(vault_path("").unwrap(), "");
        assert_eq!(vault_path(".").unwrap(), "");
        assert_eq!(vault_path("./a/b/").unwrap(), "a/b");
        assert_eq!(
            note_path("a/\u{BA54}\u{BAA8}.MD").unwrap(),
            "a/\u{BA54}\u{BAA8}.MD"
        );
        for bad in [
            "/abs/a.md",
            "../a.md",
            "a//b.md",
            ".git/config",
            "a/.hidden.md",
        ] {
            assert_eq!(vault_path(bad).unwrap_err().kind, "invalid_path", "{bad}");
        }
        assert!(entry_path("./").is_err());
        assert!(note_path("a/config.json").is_err());
        assert!(note_path("a").is_err());

        assert!(is_within("a", "", false) && is_within("a/b", "", true));
        assert!(!is_within("a/b", "", false));
        assert!(is_within("a/b", "a", false) && is_within("a/b/c", "a", true));
        assert!(!is_within("a/b/c", "a", false));
        // A name that only begins like the folder's is another entry.
        assert!(!is_within("ab/c", "a", true) && !is_within("a", "a", true));
    }

    #[test]
    fn a_note_keeps_its_line_breaks_and_its_mark() {
        let file = |content: &str, bom: bool| FileContent {
            content: content.to_owned(),
            bom,
            read_only: false,
            created: None,
            mtime: 1.0,
            size: 2,
            hash: "h".into(),
        };
        let note = Opened::from(file("a\r\nb", true));
        assert_eq!(note.text, "a\nb");
        let whole = appended(&note.text, &to_lf("c\r\nd\n"));
        assert_eq!(whole, "a\nb\nc\nd\n");
        assert_eq!(note.bytes(&whole), b"\xEF\xBB\xBFa\r\nb\r\nc\r\nd\r\n");

        let plain = Opened::from(file("one\n", false));
        assert_eq!(plain.bytes(&appended(&plain.text, "two")), b"one\ntwo");
        assert_eq!(appended("", "first"), "first");
        assert_eq!(line_break("a\rb\n"), "\r");
        assert_eq!(line_break("no break"), "\n");
    }

    #[test]
    fn subcommands_work_on_the_files_of_a_vault() {
        let root = scratch_dir("flow");
        let ok = |line: &[&str], piped: Option<&str>| {
            let (code, out, err) = run_in(&root, line, piped);
            assert_eq!((code, err.as_str()), (0, ""), "{line:?}");
            out
        };
        let fails = |line: &[&str], piped: Option<&str>| {
            let (code, out, err) = run_in(&root, line, piped);
            assert_eq!(out, "", "{line:?}");
            (code, err)
        };

        assert_eq!(ok(&["create", "log/day.md"], Some("# Day\r\n")), "");
        assert_eq!(
            ok(&["append", "log/day.md", "--text", "- one\n- two"], None),
            ""
        );
        assert_eq!(ok(&["read", "log/day.md"], None), "# Day\r\n- one\r\n- two");
        ok(
            &[
                "edit",
                "log/day.md",
                "--old",
                "Day\n- one",
                "--new",
                "Day\n- 1",
            ],
            None,
        );
        ok(&["write", "\u{BA54}\u{BAA8}.md"], Some("one two\n"));
        ok(&["mkdir", "empty"], None);
        fs::write(root.join(".hidden.md"), "two").unwrap();
        fs::write(root.join("data.json"), "{}").unwrap();

        assert_eq!(
            ok(&["ls", "-R"], None),
            "data.json\nempty/\nlog/\nlog/day.md\n\u{BA54}\u{BAA8}.md\n"
        );
        assert_eq!(ok(&["ls", "log/"], None), "log/day.md\n");
        let listed: Value = serde_json::from_str(&ok(&["ls", "--json"], None)).unwrap();
        assert_eq!(listed[1], json!({ "path": "empty", "type": "folder" }));
        assert_eq!(listed[3]["path"], "\u{BA54}\u{BAA8}.md");
        assert!(listed[3]["mtime"].as_u64().is_some_and(|mtime| mtime > 0));

        // Lines count from 1, and a hidden note is not searched.
        assert_eq!(
            ok(&["search", "TWO"], None),
            "log/day.md:3:- two\n\u{BA54}\u{BAA8}.md:1:one two\n"
        );
        let read: Value =
            serde_json::from_str(&ok(&["read", "log/day.md", "--json"], None)).unwrap();
        assert_eq!(read["content"], "# Day\r\n- 1\r\n- two");

        // What fails says why, and leaves the files as they were.
        assert_eq!(fails(&["create", "log/day.md"], None).0, FAILED);
        assert_eq!(fails(&["write", "log/day.md"], Some("")).0, MISUSED);
        assert_eq!(
            fails(&["write", "data.json", "--text", "x"], None).0,
            FAILED
        );
        assert_eq!(fails(&["read", ".hidden.md"], None).0, FAILED);
        assert_eq!(fails(&["ls", "nowhere"], None).0, FAILED);
        ok(&["append", "twice.md", "--text", "x x"], None);
        let (code, err) = fails(
            &["edit", "twice.md", "--old", "x", "--new", "y", "--json"],
            None,
        );
        assert_eq!(code, FAILED);
        let report: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(report["error"]["kind"], "ambiguous");
        let edited = ok(
            &[
                "edit", "twice.md", "--old", "x", "--new", "y", "--all", "--json",
            ],
            None,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&edited).unwrap()["replaced"],
            2
        );
        assert_eq!(fs::read_to_string(root.join("twice.md")).unwrap(), "y y");
        assert_eq!(
            fs::read(root.join("log/day.md")).unwrap(),
            b"# Day\r\n- 1\r\n- two"
        );

        ok(&["mv", "twice.md", "log/moved.md"], None);
        ok(&["rm", "log/moved.md", "--permanent"], None);
        ok(&["rm", "empty/", "--permanent"], None);
        assert_eq!(ok(&["ls", "log"], None), "log/day.md\n");
        fs::remove_dir_all(&root).unwrap();
    }
}
