//! File watcher: notify-debouncer-full batches → `vault:changed`
//! (ARCHITECTURE §6.4, TREE-12, SAVE-05).

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, DebouncedEvent, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::fs_ops;
use crate::vault::{self, VaultState};

/// Event name; mirrors `EVENT_VAULT_CHANGED` in src/lib/ipc/events.ts.
pub const EVENT_VAULT_CHANGED: &str = "vault:changed";
const DEBOUNCE: Duration = Duration::from_millis(200);
/// A batch with more changes than this becomes one "list everything again".
const FLOOD: usize = 1000;
/// How long the source of one of our renames keeps its `remove` echo dropped.
/// Echoes arrive after the debounce; a record honored for good would swallow a
/// later, real delete of that path. A late echo costs one harmless refresh.
const MOVE_ECHO_TTL: Duration = Duration::from_secs(5);

/// `ChangeKind` in src/lib/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
    Any,
}

/// `VaultChange` in src/lib/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct VaultChange {
    pub kind: ChangeKind,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

impl VaultChange {
    fn new(kind: ChangeKind, path: String) -> Self {
        Self {
            kind,
            path,
            to: None,
        }
    }

    /// `{ kind: "any", path: "" }`: list the whole vault again.
    fn relist() -> Self {
        Self::new(ChangeKind::Any, String::new())
    }
}

/// `VaultChangedPayload` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct VaultChangedPayload {
    pub changes: Vec<VaultChange>,
}

pub type VaultWatcher = Debouncer<RecommendedWatcher, IdCache>;

/// FSEvents and Windows report the two halves of a rename separately; file IDs let
/// the debouncer pair them. inotify pairs them with cookies and needs no cache.
#[cfg(any(target_os = "macos", windows))]
pub type IdCache = ids::VaultIdCache;
#[cfg(not(any(target_os = "macos", windows)))]
pub type IdCache = notify_debouncer_full::NoCache;

#[cfg(any(target_os = "macos", windows))]
fn new_id_cache(root: &Path) -> IdCache {
    ids::VaultIdCache::new(root.to_path_buf())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn new_id_cache(_root: &Path) -> IdCache {
    notify_debouncer_full::NoCache::new()
}

#[cfg(any(target_os = "macos", windows))]
mod ids {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    use notify::RecursiveMode;
    use notify_debouncer_full::file_id::{get_file_id, FileId};
    use notify_debouncer_full::FileIdCache;

    use crate::{fs_ops, vault};

    const MAX_IDS: usize = 100_000;
    const MAX_VISITS: usize = 300_000;

    /// File IDs of the vault's visible folders, notes and images. Unlike the
    /// crate's `FileIdMap` it never follows symlinks (which could walk the whole
    /// disk), skips hidden entries and other files (their renames arrive as a
    /// remove and a create, which re-list the tree all the same), and is bounded
    /// for huge vaults.
    pub struct VaultIdCache {
        root: PathBuf,
        ids: HashMap<PathBuf, FileId>,
    }

    impl VaultIdCache {
        pub fn new(root: PathBuf) -> Self {
            Self {
                root,
                ids: HashMap::new(),
            }
        }
    }

    impl FileIdCache for VaultIdCache {
        fn cached_file_id(&self, path: &Path) -> Option<impl AsRef<FileId>> {
            self.ids.get(path)
        }

        fn add_path(&mut self, path: &Path, recursive_mode: RecursiveMode) {
            let Some(rel) = vault::to_rel(&self.root, path) else {
                return;
            };
            if rel.split('/').any(|c| c.starts_with('.')) {
                return;
            }
            let depth = if recursive_mode == RecursiveMode::Recursive {
                usize::MAX
            } else {
                1
            };
            let walk = walkdir::WalkDir::new(path)
                .follow_links(false)
                .max_depth(depth)
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !fs_ops::is_hidden_name(e.file_name()));
            for (visited, entry) in walk.enumerate() {
                if visited >= MAX_VISITS || self.ids.len() >= MAX_IDS {
                    break;
                }
                let Ok(entry) = entry else { continue };
                let file_type = entry.file_type();
                let keep = file_type.is_dir()
                    || (file_type.is_file()
                        && entry
                            .file_name()
                            .to_str()
                            .is_some_and(fs_ops::is_linkable_name));
                if keep {
                    if let Ok(id) = get_file_id(entry.path()) {
                        self.ids.insert(entry.into_path(), id);
                    }
                }
            }
        }

        fn remove_path(&mut self, path: &Path) {
            self.ids.retain(|p, _| !p.starts_with(path));
        }
    }
}

/// Starts a recursive, symlink-ignoring watcher on `root`. Its batches are dropped
/// once a vault newer than `epoch` is open.
pub fn start(app: AppHandle, root: &Path, epoch: u64) -> notify::Result<VaultWatcher> {
    let batch_root = root.to_path_buf();
    let handler = move |result: DebounceEventResult| match result {
        Ok(events) => on_events(&app, &batch_root, epoch, &events),
        Err(errors) => {
            for error in errors {
                log::warn!("watcher: {error}");
            }
        }
    };
    let config = notify::Config::default().with_follow_symlinks(false);
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, IdCache>(
        DEBOUNCE,
        None,
        handler,
        new_id_cache(root),
        config,
    )?;
    debouncer.watch(root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

fn on_events(app: &AppHandle, root: &Path, epoch: u64, events: &[DebouncedEvent]) {
    let Some(state) = app.try_state::<VaultState>() else {
        return;
    };
    if state.epoch() != epoch {
        return;
    }
    let mut changes = Vec::new();
    for event in events {
        map_event(root, event, &mut changes);
    }
    let mut seen = HashSet::new();
    changes.retain(|change| seen.insert(change.clone()));
    changes.retain(|change| !is_echo(&state, root, change));
    if changes.is_empty() || state.epoch() != epoch {
        return;
    }
    if changes.len() > FLOOD {
        changes = vec![VaultChange::relist()];
    }
    if let Err(e) = app.emit(EVENT_VAULT_CHANGED, VaultChangedPayload { changes }) {
        log::warn!("emit {EVENT_VAULT_CHANGED}: {e}");
    }
}

/// `path` as a `VaultPath` when it is inside the root, UTF-8, and has no hidden
/// component (this also covers our `.mn~` temp files).
fn visible_rel(root: &Path, path: &Path) -> Option<String> {
    let rel = vault::to_rel(root, path)?;
    (!rel.split('/').any(|c| c.starts_with('.'))).then_some(rel)
}

/// What is at a path when the batch is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Present {
    Dir,
    /// A regular file: the tree lists every one (TREE-01).
    File,
    /// A symlink, or something that is neither a folder nor a regular file.
    Unlisted,
    Missing,
}

fn probe(path: &Path) -> Present {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Present::Unlisted,
        Ok(meta) if meta.is_dir() => Present::Dir,
        Ok(meta) if meta.is_file() => Present::File,
        Ok(_) => Present::Unlisted,
        Err(_) => Present::Missing,
    }
}

/// A note or an image: one class for pairing renames, apart from every other file.
fn has_linkable_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(fs_ops::is_linkable_name)
}

/// A note, an image or a code file: the files the frontend reads or shows by content.
fn has_content_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(fs_ops::is_content_name)
}

/// Maps one debounced event (ARCHITECTURE §6.4 + TECHNIQUES §3.3). Single paths
/// are classified by what is there now: a path that exists is a `create`
/// (moved in, recreated) or `modify` (content/metadata change, sent for notes,
/// images and code files only); a path that is gone is a `remove`. A notify
/// `Rescan`, or an event on the root itself, asks for a full re-list.
fn map_event(root: &Path, event: &DebouncedEvent, out: &mut Vec<VaultChange>) {
    if event.need_rescan() {
        out.push(VaultChange::relist());
        return;
    }
    let Some(path) = event.paths.first() else {
        return;
    };
    match event.kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            map_rename(root, path, &event.paths[1], out);
        }
        EventKind::Access(_) | EventKind::Other => {}
        kind => map_single(root, path, kind, out),
    }
}

fn map_single(root: &Path, path: &Path, kind: EventKind, out: &mut Vec<VaultChange>) {
    let Some(rel) = visible_rel(root, path) else {
        return;
    };
    let content_change = matches!(
        kind,
        EventKind::Modify(
            ModifyKind::Data(_) | ModifyKind::Metadata(_) | ModifyKind::Any | ModifyKind::Other
        )
    );
    if rel.is_empty() {
        if !content_change {
            out.push(VaultChange::relist());
        }
        return;
    }
    match probe(path) {
        // Also a file that came and went within the batch: the frontend drops a
        // remove of a path it never listed (§8.2).
        Present::Missing => out.push(VaultChange::new(ChangeKind::Remove, rel)),
        Present::Unlisted => {}
        Present::Dir if content_change => {}
        Present::File if content_change && !has_content_name(path) => {}
        Present::Dir | Present::File => {
            let change = match kind {
                EventKind::Any => ChangeKind::Any,
                _ if content_change => ChangeKind::Modify,
                _ => ChangeKind::Create,
            };
            out.push(VaultChange::new(change, rel));
        }
    }
}

/// A paired rename, classified by both ends (TECHNIQUES §3.3). Between two
/// listed paths of one class (folders, notes and images, other files) it is a
/// `rename`. Across classes, as when another app saves a note through a visible
/// temp file (`a.md.tmp` → `a.md`) or keeps a backup (`a.md` → `a.md~`), it is
/// a `remove` and a `create`, so a live note sees a create as for any atomic
/// save. Hidden → listed is a `create`, listed → hidden or outside a `remove`.
/// When the source exists again (vim's backup-then-write) the source is a
/// change and the target a `create`.
fn map_rename(root: &Path, from: &Path, to: &Path, out: &mut Vec<VaultChange>) {
    let from_rel = visible_rel(root, from);
    let to_rel = visible_rel(root, to);
    if from_rel.as_deref() == Some("") || to_rel.as_deref() == Some("") {
        out.push(VaultChange::relist());
        return;
    }
    let to_state = probe(to);
    // The source had the target's type, and a symlink or special file is never listed.
    let from_ok = from_rel.is_some() && to_state != Present::Unlisted;
    let to_ok = to_rel.is_some() && to_state != Present::Unlisted;
    let same_class = to_state == Present::Dir || has_linkable_name(from) == has_linkable_name(to);
    match (from_rel, to_rel) {
        (Some(from_rel), Some(to_rel)) if from_ok && to_ok && same_class => match probe(from) {
            Present::Missing => out.push(VaultChange {
                kind: ChangeKind::Rename,
                path: from_rel,
                to: Some(to_rel),
            }),
            again => {
                let kind = if again == Present::Dir {
                    ChangeKind::Create
                } else {
                    ChangeKind::Modify
                };
                out.push(VaultChange::new(kind, from_rel));
                out.push(VaultChange::new(ChangeKind::Create, to_rel));
            }
        },
        (from_rel, to_rel) => {
            if let Some(from_rel) = from_rel.filter(|_| from_ok) {
                out.push(VaultChange::new(ChangeKind::Remove, from_rel));
            }
            if let Some(to_rel) = to_rel.filter(|_| to_ok) {
                out.push(VaultChange::new(ChangeKind::Create, to_rel));
            }
        }
    }
}

/// Our own write or rename coming back (SAVE-05): the path still matches what the
/// registry recorded, or it is the vanished source of one of our recent renames.
fn is_echo(state: &VaultState, root: &Path, change: &VaultChange) -> bool {
    let abs = vault::join_rel(root, &change.path);
    match change.kind {
        ChangeKind::Create | ChangeKind::Modify | ChangeKind::Remove => {
            let Some(record) = state.registry().get(&abs) else {
                return false;
            };
            match fs::symlink_metadata(&abs) {
                Ok(meta) => fs_ops::matches_record(&abs, &meta, &record),
                Err(_) => change.kind == ChangeKind::Remove && recently_moved_away(&record),
            }
        }
        ChangeKind::Rename => {
            let Some(to) = &change.to else { return false };
            let to_abs = vault::join_rel(root, to);
            let (from_record, to_record) = {
                let registry = state.registry();
                (registry.get(&abs), registry.get(&to_abs))
            };
            match (from_record, to_record) {
                // The pair itself identifies our rename; a content change of the
                // target arrives as its own event and is checked on its own.
                (Some(from), Some(to_record))
                    if recently_moved_away(&from) && !to_record.moved_away =>
                {
                    fs::symlink_metadata(&to_abs)
                        .is_ok_and(|meta| fs_ops::matches_size_mtime(&meta, &to_record))
                }
                _ => false,
            }
        }
        ChangeKind::Any => false,
    }
}

/// The record marks the source of one of our renames, made moments ago.
fn recently_moved_away(record: &fs_ops::Record) -> bool {
    record.moved_away && record.at.elapsed() < MOVE_ECHO_TTL
}
