# Oldfolio v1 foundation

## Data authority

Markdown and attachment bytes in the selected vault are authoritative. SQLite, embeddings,
graph edges, generated previews, and job state are derived and may be deleted and rebuilt.
AI edits are expressed as revision-bound change sets; stale changes are rejected rather than
silently rebased.

## Vault modes

- Native notes live under `notes/` and are never rewritten merely by opening or indexing them.
- Strict OKF bundles live under `bundles/`. Reserved `index.md` and `log.md` semantics apply only
  inside these bundle roots.
- Oldfolio runtime data lives under `.oldfolio/`; caches and secrets are never synchronized.

## Sync modes

A vault has exactly one active sync mode: `none`, `webdav_e2ee`, or `folder_compat`.
WebDAV mode stores only encrypted objects remotely. Folder mode is desktop-only, may expose
plaintext to the provider, and delegates transport reliability to the provider client.

## Security boundaries

The Electron renderer has no Node.js integration. Filesystem, secret storage, media tools, AI
networking, and plugins are capability-brokered by privileged processes. Remote content is
untrusted data and is never interpreted as agent instructions.
