# Plugin security boundary

v1 exposes an Oldfolio SDK preview, not general Obsidian binary compatibility.

- Plugins execute outside the renderer and main process.
- The broker grants capabilities scoped by vault paths, network origins, attachments, clipboard,
  AI, external navigation, and background work.
- Filesystem, process, shell, secret store, unrestricted network, and security UI access are denied
  by default.
- A manifest permission increase requires fresh consent.
- Installation verifies a package hash and signature; offline packages remain supported.
- CPU, memory, message size, and time quotas terminate abusive workers without crashing the app.

Node `vm` is not treated as a security boundary. Process separation provides crash containment;
capability mediation and operating-system restrictions provide authority containment. Legal review
must approve an AGPL linking exception or alternative licensing before closed-source plugins and
App Store binaries are distributed.
