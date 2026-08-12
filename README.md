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
- Provider and connector contracts for local/BYOK AI and lawful source ingestion.

## Development

Requirements: Node.js 24+ and pnpm 10+.

```bash
pnpm install
pnpm check
pnpm dev
```

No Oldfolio account or hosted service is required. Secrets must never be written into a vault.
