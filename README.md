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
- Per-device FFmpeg/ffprobe/whisper.cpp configuration and user-approved local model import; no
  binaries or models are bundled or synchronized. Local transcription runs in verified 15-minute
  chunks and can continue from completed chunks after an interruption.
- Embedded audio/video playback for content-addressed Vault media, with HTTP Range seeking and a
  clickable transcript timeline that follows the current playback position.
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

## Local transcription setup

1. Configure an FFmpeg executable. `ffprobe` must be installed beside it (`ffprobe.exe` on Windows).
2. Configure the `whisper-cli` executable built or installed from whisper.cpp.
3. Download a converted `ggml-*.bin` model from the
   [official whisper.cpp model instructions](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).
   Multilingual `base` is a practical first model; names ending in `.en` are English-only.
4. In **Local transcription → Import GGML model**, use a short ID such as `base`, enter the model's
   source URL and actual licence, explicitly accept that licence, then select the downloaded `.bin`.
5. The SHA-256 field is optional. Fill it only when a trusted source supplies a 64-character
   SHA-256 value. The upstream model table currently displays 40-character SHA-1 values, which are
   not valid in that field.

Oldfolio copies the selected model into device-local application data, verifies its SHA-256 during
import and before transcription, and never stores the model or its path in the Vault.

For video containers, Oldfolio probes embedded subtitle streams first. Text tracks such as ASS,
SubRip/SRT, mov_text, and WebVTT are converted to WebVTT and used directly with their original
timestamps. The preferred language wins, followed by the default text track. Bitmap tracks such as
PGS, VobSub/DVD, and DVB subtitles are recorded as detected but currently fall back to Whisper;
burned-in subtitles require a future OCR pipeline.
