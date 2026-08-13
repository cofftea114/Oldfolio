# Implementation status

This repository is an executable foundation for the Oldfolio roadmap. It intentionally does not
claim that the planned 9–12 month v1 is complete.

## Working now

- Create or open a local Vault from the Electron desktop application.
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
- Persist media job checkpoints under the non-synchronized cache, requeue interrupted work at
  startup, execute local media tools without shell interpretation, and verify local model hashes
  and provenance before use.
- Generate revision-bound AI change sets and apply or atomically undo them through the Vault core.
- Connect to Ollama and OpenAI-compatible providers through secret-resolver interfaces that do not
  serialize API keys into requests or Vault configuration.
- Validate plugin manifests and broker declared first-party SDK capabilities.
- Build the Capacitor-compatible mobile capture/read shell.

## Protocol prototypes requiring product integration or review

- WebDAV E2EE object encryption, manifest hash chains, recovery material, and exclusive sync-mode
  state are implemented as tested primitives. A production WebDAV transport, pairing UI, epoch-key
  rotation workflow, and external cryptographic review are still required.
- The AI provider layer, template selector, and source connector registry are implemented, but the
  desktop settings/keychain UI and end-user change-set review UI are not yet connected.
- The mobile application is a web/Capacitor shell; native projects, keychain bindings, WebDAV sync,
  background upload behavior, and store packaging remain future work.

## Not implemented yet

- Automatic FFmpeg/`whisper.cpp` installation and settings UI, model download/licence acceptance,
  real long-media execution benchmarks, translation, and embedded time-linked media playback. The
  controlled execution adapter and resumable job core are implemented, but no model is bundled.
- Creator tracking scheduler, comments API/import flows, audience insight clustering, perspective
  evolution, and cross-creator synthesis.
- JSON Canvas generation/preview, the interactive graph workspace, and a complete plugin host process.
- Production WebDAV transport and folder-sync conflict UI.
- OS credential-store implementations, installers/signing, SBOM release pipeline, platform policy
  integrations, accessibility audit, large-vault benchmarks, and mobile native builds.

The next product increment should add user-configurable FFmpeg/`whisper.cpp` paths and a verified
model-download flow, then run the implemented adapter through long-media interruption tests.
