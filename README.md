# Oldfolio

Oldfolio is a local-first, account-free knowledge application for Markdown, OKF knowledge
bundles, media-derived notes, and user-controlled AI providers.

## Current implementation slice

- Electron desktop shell with a sandboxed renderer and narrow preload bridge.
- Capacitor-compatible mobile web shell.
- Lossless native Markdown vault and strict OKF v0.2 bundle validation.
- Native Markdown note creation plus revision-checked deletion with immediate atomic undo.
- Rebuildable local search and link graph.
- Local Ollama/LM Studio or online OpenAI-compatible transcript summaries with automatic template
  selection, a controlled transcript document reader, reviewable revision-bound change sets,
  approval, and atomic undo.
- WebDAV encrypted-sync protocol primitives and mutually exclusive sync modes.
- Provider contracts for local/BYOK AI.
- Working RSS/Atom/Podcast and injected local-file ingestion into immutable OKF Source snapshots.
- Desktop SRT/WebVTT import into timestamp-linked OKF Transcript notes, backed by resumable media jobs.
- Public HTTPS audio/video direct-link import with bounded streaming download, embedded-subtitle
  preference, resumable online speech transcription, and explicit provider disclosure.
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

## AI summary setup

1. Start either Ollama or LM Studio on the same computer. In LM Studio, start the local server and
   make the chat model visible to the server.
2. Open a Vault and select **AI workspace**. Choose **Ollama** or **LM Studio**. Defaults are
   `http://127.0.0.1:11434/api/` for Ollama and `http://127.0.0.1:1234/api/v1/` for LM Studio; entering
   only the loopback host and port is also accepted and normalized automatically.
3. Select **Detect local models**, choose a chat model, and save the device configuration.
   Oldfolio prefers the context length of the currently loaded LM Studio instance over the model's
   theoretical maximum. If the engine later reports a smaller real limit, the summary is replanned
   once with bounded document windows and the local setting is corrected after a successful retry.
4. Open an Oldfolio-generated Transcript and select **Prepare summary**. Review the exact plain-text
   working document, destination, model, automatic template, estimated input size, and cost disclosure
   before sending it. Oldfolio writes a revision-bound plain-text working document under
   `.oldfolio/cache/ai-inputs/`. If it does not fit a typical local-model context, the model reads
   bounded windows while maintaining one global set of notes, then produces one readable Markdown
   synthesis. It does not create independent summaries and mechanically merge them.
   Choose automatic source-language output, Simplified Chinese, or English before generation. Explicit
   language choices create independent OKF notes so translated versions can coexist.
5. Review the generated OKF `Synthesis` document and diff. Nothing is written until **Approve and
   write to Vault** is selected; the resulting write can be atomically undone while unchanged.

LM Studio uses its native v1 chat API with reasoning disabled for fast summaries and the editing stage. The AI
workspace keeps **Transcription** and **Summary** as independent modules, and each can select local or
online execution. Online summary presets are available for OpenAI, DeepSeek, Kimi, GLM, MiniMax, Grok,
Qwen, and Gemini; the endpoint and model remain editable for compatible regional or custom endpoints.
Explicitly confirm the destination host before saving. Endpoint and model names are device-local. Until
native OS credential storage is implemented, the API Key exists
only in main-process memory for the current application run and must be entered again after restart;
it is never written to the Vault, SQLite index, device config, or logs.

## Online media analysis

1. Configure FFmpeg under **Transcription**. To analyze a YouTube, bilibili, or Douyin share link,
   install `yt-dlp` yourself and select its executable in the same module. Oldfolio invokes it with
   browser cookies, playlists, and user config disabled, after an explicit authorization confirmation.
2. Choose local Whisper to process a direct media URL or supported platform share link entirely with
   the configured local model. Alternatively, choose OpenAI-compatible transcription or Tencent Cloud
   recording-file recognition. OpenAI-compatible transcription reuses the explicitly confirmed online
   endpoint/key but has its own model selection. Tencent receives local 64-kbps AAC chunks kept below
   its raw-data request limit. Tencent defaults to the `16k_zh` base engine, which is eligible for the
   monthly recording-file free package; paid large-model engines are explicitly labeled in the selector.
3. Paste a public direct HTTPS media URL or a YouTube, bilibili, or Douyin video share link under
   **Online video**. Authenticated/private content, browser Cookie extraction, playlists, private-network
   targets, and embedded URL credentials remain unsupported.
4. Oldfolio streams at most 2 GB into a content-addressed Vault asset. It first extracts a supported
   embedded text subtitle locally. If none is available, FFmpeg creates bounded audio chunks and the
   configured chunk-capable provider receives only those chunks. Completed chunk artifacts are hashed so
   interrupted jobs can continue without retranscribing verified chunks.
5. Open the generated Transcript, choose the online summary target, inspect the complete document and
   destination disclosure, then confirm generation. The provider is contacted directly from the device;
   Oldfolio does not proxy requests or estimate third-party charges.
