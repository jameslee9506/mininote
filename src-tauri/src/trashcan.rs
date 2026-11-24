//! The system's trash: putting an entry in it, and bringing one back (TREE-08,
//! TREE-21). `fs_ops` guards the vault's paths; this module only talks to the
//! system.
//!
//! macOS says where a trashed entry went, and a rename brings it back from there.
//! Windows and the freedesktop trash keep their own record of every entry, by its
//! old path and the time it went, and restore it themselves.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Entries remembered at most. The frontend's undo history is shorter (TREE-21).
const RECORDS_CAP: usize = 128;

/// An entry in the trash, as [`put`] left it.
#[derive(Debug, Clone)]
pub struct Trashed {
    /// Where the entry was.
    pub original: PathBuf,
    /// macOS: where it is now. `None` when the system did not say, and elsewhere.
    pub location: Option<PathBuf>,
    /// When it went, in seconds since the Unix epoch: with `original`, what
    /// Windows and the freedesktop trash know the entry by.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub at: i64,
}

/// Why [`take_back`] brought nothing back.
#[derive(Debug)]
pub enum RestoreError {
    /// The entry is no longer in the trash, or the trash cannot be asked for it.
    Gone,
    /// Something is where the entry was.
    Taken,
    Other(String),
}

/// The entries `path_trash` put in the trash for one vault, by the ticket given
/// out for each. The oldest is forgotten first.
#[derive(Debug, Default)]
pub struct TrashRecords {
    entries: HashMap<u64, (String, Trashed)>,
    /// Never reset: a ticket of a vault that was closed names nothing later.
    seq: u64,
}

impl TrashRecords {
    /// Remembers `trashed`, the entry that was at the vault path `rel`, and
    /// returns its ticket.
    pub fn insert(&mut self, rel: String, trashed: Trashed) -> u64 {
        self.seq += 1;
        self.entries.insert(self.seq, (rel, trashed));
        if self.entries.len() > RECORDS_CAP {
            if let Some(oldest) = self.entries.keys().min().copied() {
                self.entries.remove(&oldest);
            }
        }
        self.seq
    }

    pub fn get(&self, ticket: u64) -> Option<(String, Trashed)> {
        self.entries.get(&ticket).cloned()
    }

    pub fn remove(&mut self, ticket: u64) {
        self.entries.remove(&ticket);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Moves the entry `abs` to the system's trash: a link itself, never its file.
pub fn put(abs: &Path) -> Result<Trashed, String> {
    let at = now_secs();
    let location = put_in_trash(abs)?;
    Ok(Trashed {
        original: abs.to_path_buf(),
        location,
        at,
    })
}

/// `NSFileManager` itself, and not the `trash` crate's call of it, which drops
/// the place the entry went to. Never Finder through AppleScript: that can raise
/// an Automation permission prompt (TREE-08).
#[cfg(target_os = "macos")]
fn put_in_trash(abs: &Path) -> Result<Option<PathBuf>, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    use trash::macos::{DeleteMethod, TrashContextExtMacos};

    let Some(path) = abs.to_str() else {
        // A name that is not UTF-8: the crate knows how to pass it on.
        let mut trash = trash::TrashContext::default();
        trash.set_delete_method(DeleteMethod::NsFileManager);
        return trash.delete(abs).map(|()| None).map_err(|e| e.to_string());
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let mut resulting = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| e.to_string())?;
    Ok(resulting
        .and_then(|url| url.path())
        .map(|path| PathBuf::from(path.to_string())))
}

#[cfg(not(target_os = "macos"))]
fn put_in_trash(abs: &Path) -> Result<Option<PathBuf>, String> {
    trash::delete(abs).map(|()| None).map_err(|e| e.to_string())
}

/// Brings `trashed` back to `to`, the place it was in. Never over an entry that
/// is there: the caller has checked, and `still_free` is asked again right before
/// the entry moves.
#[cfg(target_os = "macos")]
pub fn take_back(
    trashed: &Trashed,
    to: &Path,
    still_free: &dyn Fn() -> bool,
) -> Result<(), RestoreError> {
    use std::fs;
    use std::io::ErrorKind;

    let location = trashed.location.as_deref().ok_or(RestoreError::Gone)?;
    // Listing the trash needs Full Disk Access; an entry named by its path does not.
    match fs::symlink_metadata(location) {
        Ok(_) => {}
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Err(RestoreError::Gone)
        }
        Err(e) => return Err(RestoreError::Other(e.to_string())),
    }
    if !still_free() {
        return Err(RestoreError::Taken);
    }
    fs::rename(location, to).map_err(|e| match e.kind() {
        ErrorKind::NotFound => RestoreError::Gone,
        _ => RestoreError::Other(e.to_string()),
    })
}

/// Brings `trashed` back to `to`, the place it was in: the system restores the
/// entry it recorded for that path, the one trashed nearest to `trashed.at`.
#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
pub fn take_back(
    trashed: &Trashed,
    to: &Path,
    still_free: &dyn Fn() -> bool,
) -> Result<(), RestoreError> {
    use trash::os_limited::{list, restore_all};

    // The system puts the entry back where its own record says it was.
    if !same_place(to, &trashed.original) {
        return Err(RestoreError::Gone);
    }
    let items = list().map_err(|e| RestoreError::Other(e.to_string()))?;
    let item = items
        .into_iter()
        .filter(|item| same_place(&item.original_path(), &trashed.original))
        .min_by_key(|item| item.time_deleted.abs_diff(trashed.at))
        .ok_or(RestoreError::Gone)?;
    if !still_free() {
        return Err(RestoreError::Taken);
    }
    match restore_all([item]) {
        Ok(()) => Ok(()),
        Err(trash::Error::RestoreCollision { .. }) => Err(RestoreError::Taken),
        Err(e) => Err(RestoreError::Other(e.to_string())),
    }
}

/// No trash that gives an entry back on this system.
#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    all(unix, not(target_os = "ios"), not(target_os = "android"))
)))]
pub fn take_back(
    _trashed: &Trashed,
    _to: &Path,
    _still_free: &dyn Fn() -> bool,
) -> Result<(), RestoreError> {
    Err(RestoreError::Gone)
}

/// Two spellings of one path, as the trash's record and the vault give them.
/// Windows writes a long path with a `\\?\` prefix and compares names without
/// case.
#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
fn same_place(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    if cfg!(windows) {
        let fold = |p: &Path| {
            p.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_lowercase()
        };
        return fold(a) == fold(b);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trashed(name: &str) -> Trashed {
        Trashed {
            original: PathBuf::from(name),
            location: None,
            at: 0,
        }
    }

    #[test]
    fn records_give_each_entry_a_ticket_of_its_own() {
        let mut records = TrashRecords::default();
        let a = records.insert("a.md".into(), trashed("/v/a.md"));
        let b = records.insert("b.md".into(), trashed("/v/b.md"));
        assert_ne!(a, b);
        assert_eq!(records.get(a).map(|(rel, _)| rel).as_deref(), Some("a.md"));
        records.remove(a);
        assert!(records.get(a).is_none());
        // A ticket is never given out twice, also after the records were cleared.
        records.clear();
        let c = records.insert("c.md".into(), trashed("/v/c.md"));
        assert!(c > b);
        assert!(records.get(b).is_none());
    }

    #[test]
    fn records_forget_the_oldest_entry_first() {
        let mut records = TrashRecords::default();
        let first = records.insert("0.md".into(), trashed("/v/0.md"));
        let mut last = first;
        for i in 1..=RECORDS_CAP {
            last = records.insert(format!("{i}.md"), trashed("/v/x.md"));
        }
        assert!(records.get(first).is_none());
        assert!(records.get(first + 1).is_some());
        assert!(records.get(last).is_some());
    }
}
