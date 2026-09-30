//! Wire types shared with the frontend. Mirrored in `src/ipc/types.ts`;
//! see `docs/ipc.md` and change all three together.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub target_is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PanelEvent {
    Snapshot {
        path: String,
        parent: Option<String>,
        entries: Vec<Entry>,
    },
    Patch {
        path: String,
        removed: Vec<String>,
        upserted: Vec<Entry>,
    },
    Error {
        path: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Copy,
    Move,
}

/// The user's answer to an `OpEvent::Conflict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Move the existing destination to the Trash, then copy/move.
    Overwrite,
    Skip,
    /// Copy/move under a free name ("name 2.ext").
    KeepBoth,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OpEvent {
    Progress {
        id: u64,
        files_done: u64,
        files_total: u64,
        bytes_done: u64,
        bytes_total: u64,
        current: String,
    },
    Conflict {
        id: u64,
        path: String,
    },
    Done {
        id: u64,
        errors: Vec<String>,
    },
    Cancelled {
        id: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}
