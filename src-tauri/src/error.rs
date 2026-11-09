//! The single error type every command returns. It serializes exactly as
//! `IpcErrorPayload` (`{ kind, message }`) in src/lib/types.ts.

use std::fmt;
use std::io;

use serde::Serialize;

/// Mirrors `IpcErrorKind` in src/lib/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NoVault,
    RootUnavailable,
    InvalidPath,
    NotFound,
    Exists,
    Conflict,
    ReadOnly,
    NotUtf8,
    TooLarge,
    TrashFailed,
    Io,
}

/// `{ kind, message }`: the rejection value of every failed `invoke`.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Maps an I/O error from a generic operation. `context` says what was being done.
    pub fn from_io(err: io::Error, context: &str) -> Self {
        let kind = match err.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => ErrorKind::NotFound,
            io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty => ErrorKind::Exists,
            io::ErrorKind::ReadOnlyFilesystem => ErrorKind::ReadOnly,
            io::ErrorKind::InvalidFilename => ErrorKind::InvalidPath,
            _ => ErrorKind::Io,
        };
        Self::new(kind, format!("{context}: {err}"))
    }

    /// Like [`AppError::from_io`], but a refused write (no permission, read-only
    /// volume) becomes `read_only`: retrying cannot succeed (SAVE-08).
    pub fn from_write(err: io::Error, context: &str) -> Self {
        match err.kind() {
            io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
                Self::new(ErrorKind::ReadOnly, format!("{context}: {err}"))
            }
            _ => Self::from_io(err, context),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}
