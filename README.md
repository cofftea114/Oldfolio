# Oldfolio

Oldfolio is a local-first, account-free knowledge application for Markdown, OKF knowledge
bundles, media-derived notes, and user-controlled AI providers.

## Current implementation slice

- Electron desktop shell with a sandboxed renderer and narrow preload bridge.
- Capacitor-compatible mobile web shell.
- Lossless native Markdown vault and strict OKF v0.2 bundle validation.
- Rebuildable local search and link graph.
- Reviewable, revision-bound AI change sets.
- WebDAV encrypted-sync protocol primitives and mutually exclusive sync modes.
- Provider contracts for local/BYOK AI.
- Working RSS/Atom/Podcast and injected local-file ingestion into immutable OKF Source snapshots.
- Desktop SRT/WebVTT import into timestamp-linked OKF Transcript notes, backed by resumable media jobs.
- Per-device FFmpeg/whisper.cpp configuration and user-approved local model import; no binaries or
  models are bundled or synchronized.
- Desktop RSS/Podcast import UI with bounded, credential-free remote fetching.

This repository is the first executable foundation slice, not the complete v1 described in the
product roadmap. See [implementation status](docs/implementation-status.md) for the exact boundary.

## Development

Requirements: Node.js 24+ and pnpm 10+.

```bash
pnpm install
pnpm check
pnpm dev
```

The first desktop launch may download the Electron runtime. `pnpm dev` performs this check before
electron-vite starts, so an interrupted initial download can be retried safely.

No Oldfolio account or hosted service is required. Secrets must never be written into a vault.
