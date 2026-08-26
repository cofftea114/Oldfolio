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
- Follow RSS, Atom, and Podcast creators from the desktop UI. Each subscription creates an isolated
  `bundles/creators/<creator-id>/` OKF bundle with a visible Creator profile and immutable raw source
  revisions. Refresh state is stored in `.oldfolio/config/` so it can follow the Vault across devices;
  the running desktop checks overdue feeds at startup and every 15 minutes, with a one-hour per-feed
  interval. Manual single/all refresh, GUID-based new-entry counts, failure state, and unfollow while
  preserving the knowledge bundle are implemented. The subscription panel can browse the bounded
  history returned by each Feed, including title, publish time, author, duration, media type, and
  controlled opening of the original or enclosure URL. Existing subscriptions lazily backfill this
  catalog on first history access.
- The creator input accepts homepage and Feed URLs. It performs a bounded, credential-free request,
  recognizes direct RSS/Atom, and validates declarative alternate-feed links without executing page
  scripts. YouTube `/channel/UC…` URLs and channel IDs declared in non-executable page metadata are
  converted to and validated against YouTube's public Atom Feed. The returned entry count is explicitly
  described as recent Feed history, not complete channel history; complete history still requires the
  official YouTube Data API uploads-playlist pagination path. Bilibili and Douyin pages without a public
  Feed report that an approved official-API connector and user authorization are required and do not
  fall back to page scraping.
- YouTube Data API BYOK is available inside the creator panel. The key remains in the device secret
  store and is transmitted with `X-Goog-Api-Key`, never in the request URL, Vault, SQLite, synchronized
  settings, or logs. `channels.list` resolves channel IDs and uploads playlists; `playlistItems.list`
  walks official 50-item pages up to the current 2,000-entry per-creator bound. Results merge with Feed
  observations instead of being erased by later refreshes and are saved as immutable API Source
  snapshots. Quota, invalid-key, disabled-API, channel-not-found, network, JSON, and response-size
  failures are explicit.
- A stored creator-history entry can be sent to the media analysis workbench for local Whisper or
  configured online transcription. Creator attribution is not trusted from the renderer: the main
  process resolves the authoritative subscription and entry, verifies that the submitted URL belongs
  to it, and selects the destination bundle. Generated immutable Source snapshots, Transcript notes,
  Synthesis summaries, reusable Concepts, index links, and maintenance-log entries stay under the same
  `bundles/creators/<creator-id>/` bundle.
- Creator histories can generate an offline title knowledge graph without sending titles to an AI
  provider. Stable nodes are connected by bounded, non-directional edges using corpus-adjusted title
  phrase similarity; repeated creator boilerplate is excluded and each title has at most four strong
  relations. The complete graph is validated and stored as JSON Canvas under the owning Creator
  bundle, linked from its index, and recorded in its maintenance log. The desktop renders up to 2,000
  nodes in an interactive force-directed Canvas knowledge star map with zoom, pan, node dragging,
  search, local-neighborhood focus, and double-click navigation to the original entry.
- Import local text and caption sources through the reusable connector API.
- Import SRT/WebVTT captions from the desktop UI, parse timestamped and speaker-attributed segments,
  and compile strict OKF `Transcript` concepts linked back to the local source time position.
- Persist media job requests and SHA-256-verified chunk checkpoints under the non-synchronized
  cache, requeue interrupted work at startup, expose retry controls for queued/failed jobs, and allow
  confirmed deletion of failed job metadata and intermediate cache without deleting Vault assets or notes.
- Batch-select up to 100 already-downloaded local media files for local Whisper or configured online
  transcription. The main process keeps source paths out of the renderer, validates that files remain
  unchanged between preview and confirmation, and copies every accepted file into content-addressed
  Vault assets before returning. YouTube, Bilibili, and Douyin IDs in filenames are matched exactly
  against followed creator history; filenames containing only the normalized exact video title also
  produce suggestions. ID matches are ranked first, ambiguous same-title matches remain explicit, and
  every destination is user-editable. A whole batch can be assigned directly to any currently followed
  creator, with per-file overrides. Creator-only assignments route output to that Creator Bundle without
  inventing a history-entry ID, and the main process revalidates the current subscription before queueing. All accepted
  jobs are persisted before a single-worker background queue starts; one failure does not block later
  files, interrupted queued batches resume when the Vault is reopened, and each queued or running batch
  item can be stopped independently. Cancelled and failed task metadata can then be deleted without
  deleting imported Vault media or generated notes.
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
- Import a public HTTPS audio/video direct link without ambient credentials or automatic redirects.
  The desktop streams a bounded response into a content-addressed Vault asset, rejects unsupported
  media and private literal hosts, prefers embedded text subtitles, and otherwise uses local FFmpeg
  to create deterministic audio chunks for an online OpenAI-compatible transcription model. Chunk
  JSON artifacts are SHA-256 verified and reusable after interruption; the remote host and model are
  bound to the persisted retry request.
- Resolve user-authorized YouTube, bilibili, and Douyin share links through a user-selected `yt-dlp`
  executable. The controlled invocation disables browser cookies, playlists, user configuration, and
  shell execution; the downloaded media remains bounded and is removed from transient cache after it is
  imported into the Vault. The same URL entry can feed local Whisper or a chunk-capable cloud provider.
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
  follows the transcript's Chinese/English language by default, or explicitly generates Simplified Chinese or
  English. Explicit language versions use separate paths and stable IDs so translations coexist. Summary output
  is readable Markdown rather than schema-bound JSON. Preview the complete OKF `Synthesis` content and diff,
  and apply or undo the resulting L1/L2 change set.
  LM Studio planning uses the smallest active loaded-instance context. A typed context-limit response can
  trigger one bounded local replan using the engine-reported limit; unrelated provider failures are not retried.
- Extract reusable, theme-first OKF `Concept` pages from generated summaries without requiring strict JSON.
  Existing normalized titles are updated in place with stable IDs; new concepts, the owning bundle index, and the
  maintenance log are written as one reviewable atomic change set. Personal notes, concepts, summaries,
  saved Q&A, and transcripts are presented in separate sidebar groups.
- Ask questions against the local knowledge base with maintained Wiki pages ranked ahead of source transcripts.
  The exact retrieved payload is disclosed before local or online inference, unknown model-authored Wiki links
  are removed, and a deterministic reference list is appended locally. Answers remain L0 and in memory unless
  the user explicitly approves an L1/L2 OKF Q&A change set; saved answers update the bundle index and log.
- Configure transcription and summary independently for local or online execution. Online summaries
  provide editable OpenAI-compatible presets for OpenAI, DeepSeek, Kimi, GLM, MiniMax, Grok, Qwen,
  Gemini, and OpenRouter. OpenRouter supports model discovery, defaults zero-credit accounts to the
  `openrouter/free` router, loads the authenticated `/models` catalog with model names and context lengths,
  and provides searchable selection while retaining manual model IDs. It keeps `openrouter/auto` and specific
  paid models as explicit choices, sends attribution headers, and maps its unified reasoning controls for summaries, concepts, and Wiki Q&A.
  OpenRouter chat completions use bounded SSE reception so long generations keep the connection active and are
  accepted only after the terminal marker; interrupted partial output is discarded without an automatic paid retry.
  Remote online AI uses Node's HTTP stack independently from the Chromium `net.fetch` transport retained for
  long-waiting local LM Studio requests, and safe low-level transport codes are preserved in interruption errors.
  If a reasoning-mandatory OpenRouter model explicitly rejects `effort: none` with HTTP 400, Oldfolio performs
  one bounded retry using that model's provider-default reasoning; unrelated client errors are never retried.
  Other providers explicitly request non-streaming JSON, and empty, truncated, HTML gateway, or unexpected SSE
  responses are classified without exposing returned content. Provider HTTP 402 responses become actionable
  insufficient-credit errors. OpenRouter is explicitly excluded
  from audio transcription because it does not expose the required `/audio/transcriptions` contract.
  Online transcription supports OpenAI-compatible audio models and Tencent Cloud
  recording-file recognition with signed asynchronous polling. Tencent defaults to the free-package-eligible
  `16k_zh` engine and separates base and paid large-model engines in a validated selector.
  The user must explicitly confirm the summary destination host and can inspect the complete summary
  working document before it is sent. Only endpoints, provider/model settings, and opaque secret references are serialized.
  Desktop online AI and Tencent credentials are encrypted asynchronously through Electron `safeStorage`
  and atomically stored in the device-data directory. Online AI credentials use independent provider slots,
  including automatic migration from the previous single-key slot. Windows uses DPAPI and macOS uses Keychain. Linux
  persistence is refused when only the insecure `basic_text` backend is available. Decrypted values exist
  only in main-process memory, can be explicitly cleared, and never enter the Vault, SQLite, WebDAV,
  ordinary configuration, renderer state, or logs.
- Validate plugin manifests and broker declared first-party SDK capabilities.
- Build the Capacitor-compatible mobile capture/read shell.

## Protocol prototypes requiring product integration or review

- WebDAV E2EE object encryption, manifest hash chains, recovery material, and exclusive sync-mode
  state are implemented as tested primitives. A production WebDAV transport, pairing UI, epoch-key
  rotation workflow, and external cryptographic review are still required.
- The online OpenAI-compatible provider, desktop BYOK settings, transcription, summary flow, and
  OS-protected desktop credential persistence are integrated. Mobile Keychain/Keystore integration remains future work.
- The mobile application is a web/Capacitor shell; native projects, keychain bindings, WebDAV sync,
  background upload behavior, and store packaging remain future work.

## Not implemented yet

- Automatic FFmpeg/`whisper.cpp` installation, signed model download manifests, real-device
  long-media benchmarks, translation, and advanced waveform/chapter editing. The settings UI,
  local model import, controlled chunked execution, retry workflow, and interruption/disk-pressure
  tests are implemented, but no binary or model is bundled.
- OCR for burned-in subtitles and bitmap tracks such as PGS, VobSub/DVD, and DVB subtitles.
- Automatic queued AI summarization of newly tracked creator items, comments API/import flows, audience
  insight clustering, perspective evolution, and cross-creator synthesis.
- General AI mind-map generation, a complete freeform JSON Canvas editor, the interactive cross-bundle
  graph workspace, and a complete plugin host process. Creator title-relationship Canvas generation
  and bounded desktop preview are implemented.
- Production WebDAV transport and folder-sync conflict UI.
- Installers/signing, SBOM release pipeline, platform policy integrations, accessibility audit,
  large-vault benchmarks, mobile credential storage, and mobile native builds.
- Processing transcripts above the current 200,000-character safety limit, multi-turn conversational memory,
  and one-click batch concept extraction across multiple transcripts.

The next product increment should extend the persistent media queue with explicitly approved summary
jobs. Summary execution must retain the existing host/payload/cost disclosure, support local and online
providers independently from transcription, and never turn creator tracking into a bulk platform downloader.
