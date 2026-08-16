# Data authority and conflict state machine

## Invariants

1. Vault file bytes are the authority. Indexes and previews are disposable derivatives.
2. Every observed file version has a SHA-256 content revision.
3. Writes require the revision that the editor or change set originally read.
4. A mismatched revision never causes a silent overwrite.
5. A logical Oldfolio ID is stable across moves; an OKF Concept ID remains its bundle-relative path.

## Write state machine

```text
clean -> editing -> validating -> atomic-write -> clean
                  \-> stale-base -> merge-required
                  \-> invalid    -> rejected
atomic-write -> filesystem-error -> rollback -> clean | explicit-conflict
```

External editors produce whole-file snapshots. Oldfolio records a base snapshot and performs a
three-way merge when both local and external versions changed. If the merge is ambiguous, both
versions are preserved and a timestamped conflict copy is created. v1 does not infer CRDT
operations from file diffs.

Moves, deletes, attachment relocation, link rewriting, and tombstones are one change-set
transaction. The transaction is applied under a vault write lock, records its inverse before
mutation, and either completes or restores every touched path.

## Filesystem normalization

- Stored paths always use `/`, UTF-8, and Unicode NFC.
- Absolute paths, `..`, NUL, Windows device paths, and resolved symlinks escaping the vault fail.
- The watcher ignores Oldfolio's own atomic temporary files and coalesces duplicate notifications.
- Encoding and existing line endings are preserved until a user or approved change explicitly
  edits the document.
