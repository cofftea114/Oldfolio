# Implementation status

This repository is an executable foundation for the Oldfolio roadmap. It intentionally does not
claim that the planned 9–12 month v1 is complete.

## Working now

- Create or open a local Vault from the Electron desktop application.
- Create native Markdown notes with safe collision-free paths. Delete visible notes only after an
  explicit desktop confirmation; deletion is revision-bound, recorded in Vault history, and can be
  atomically undone from the current session. Reserved and raw OKF bundle documents stay protected.
- Edit Markdown with optimistic revision checks; search, backlinks, properties, attachments layout,
  and rebuildable SQLite/FTS indexes are implemented in the local knowledge core.
- Preserve unedited Markdown bytes and validate strict OKF v0.2 bundles without deleting unknown
  fields, types, or broken links.
- Import RSS, Atom, and Podcast feeds from the desktop UI. The source response is bounded, fetched
  without ambient credentials, treated as untrusted data, and compiled into an immutable OKF
  `Source` snapshot under `bundles/personal/raw/`.
- Import local text and caption sources through the reusable connector API.
- Import SRT/WebVTT captions from the desktop UI, parse timestamped and speaker-attributed segments,
  and compile strict OKF `Transcript` concepts linked back to the local source time position.
- Persist media job requests and SHA-256-verified chunk checkpoints under the non-synchronized
  cache, requeue interrupted work at startup, and expose retry controls for queued/failed jobs.
- Configure FFmpeg (including the adjacent `ffprobe`) and `whisper-cli` per device, import
  user-approved GGML models with streaming
  SHA-256 verification, copy selected media into content-addressed Vault assets, and run the local
  transcription adapter from the desktop UI. The adapter probes duration without decoding the full
  file, checks working-volume capacity, processes deterministic 15-minute chunks, removes temporary
  PCM files, restores timestamp offsets, and skips only completed chunks whose VTT hash still
  matches. Tool paths and installed-model records stay in the Electron device-data directory rather
  than the synchronized Vault.
- Open locally generated Transcript notes with an embedded audio/video player and clickable segment
  timeline. A private streaming protocol supports byte ranges while authorizing only
  content-addressed `assets/media/` files in the currently open Vault; arbitrary paths and ordinary
  Markdown links cannot use it.
- Probe embedded subtitle streams before speech recognition, classify text versus bitmap codecs,
  select a preferred/default language track, and convert supported text subtitles to WebVTT while
  preserving timestamps. The generated Source records all detected tracks and the chosen transcript
  provenance; extraction failures and media without text subtitles fall back to Whisper.
- Generate revision-bound AI change sets and apply or atomically undo them through the Vault core.
- Connect to Ollama and OpenAI-compatible providers through secret-resolver interfaces that do not
  serialize API keys into requests or Vault configuration.
- Configure a loopback-only Ollama or LM Studio endpoint and model in device-local settings. Root URLs
  are normalized to Ollama `/api/` or LM Studio native `/api/v1/`. For generated
  Transcript notes, automatically select a summary template, disclose the exact untrusted-data
  payload, estimated input size, and direct/document-reader processing plan. A revision-bound plain-text
  working document is stored in the non-synchronized cache. Long inputs within the 200,000-character
  safety limit are read through bounded windows into viewpoint-level notebook checkpoints rather than
  independent summaries. The final synthesis retains coverage across the whole document, deterministically
  follows the transcript's Chinese/English language, and uses one representative playback anchor per viewpoint;
  original evidence IDs remain validated at every step. Preview the complete OKF `Synthesis` content and diff,
  and apply or undo the resulting L1/L2 change set.
- Validate plugin manifests and broker declared first-party SDK capabilities.
- Build the Capacitor-compatible mobile capture/read shell.

## Protocol prototypes requiring product integration or review

- WebDAV E2EE object encryption, manifest hash chains, recovery material, and exclusive sync-mode
  state are implemented as tested primitives. A production WebDAV transport, pairing UI, epoch-key
  rotation workflow, and external cryptographic review are still required.
- The OpenAI-compatible provider and secret-resolver boundary are implemented, but its desktop
  remote/BYOK settings UI remains disabled until native OS credential stores are connected. The
  current end-user summary workflow supports loopback Ollama and LM Studio without API keys.
- The mobile application is a web/Capacitor shell; native projects, keychain bindings, WebDAV sync,
  background upload behavior, and store packaging remain future work.

## Not implemented yet

- Automatic FFmpeg/`whisper.cpp` installation, signed model download manifests, real-device
  long-media benchmarks, translation, and advanced waveform/chapter editing. The settings UI,
  local model import, controlled chunked execution, retry workflow, and interruption/disk-pressure
  tests are implemented, but no binary or model is bundled.
- OCR for burned-in subtitles and bitmap tracks such as PGS, VobSub/DVD, and DVB subtitles.
- Creator tracking scheduler, comments API/import flows, audience insight clustering, perspective
  evolution, and cross-creator synthesis.
- JSON Canvas generation/preview, the interactive graph workspace, and a complete plugin host process.
- Production WebDAV transport and folder-sync conflict UI.
- OS credential-store implementations, installers/signing, SBOM release pipeline, platform policy
  integrations, accessibility audit, large-vault benchmarks, and mobile native builds.
- Processing transcripts above the current 200,000-character safety limit, summary translation,
  AI chat, and reusable concept extraction across multiple transcripts.

The next product increment should add reusable Concept extraction and summary translation, then
connect OS credential stores for OpenAI-compatible BYOK without weakening
the current payload-disclosure and no-secret-in-Vault boundaries.
