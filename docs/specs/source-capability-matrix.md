# Source capability and compliance matrix

No connector may silently fall back to scraping, cookie extraction, DRM bypass, or hidden APIs.
Remote text and comments are untrusted data, never agent instructions.

| Source | v1 acquisition | Credentials | Stored fields | Refresh/delete | Derivatives |
|---|---|---|---|---|---|
| Local file | User-selected file | None | File, hash, metadata | User-controlled | Allowed subject to user's rights |
| Direct URL | Explicit user import of accessible resource | Optional user credential | Snapshot only after capability check | Revalidate on repeat import | Per source license |
| RSS/Atom | Standard feed request | Optional feed credential | Entry metadata and permitted content | GUID dedupe; propagate feed removal when required | Summaries with attribution |
| Podcast RSS | Feed plus user-selected enclosure | Optional feed credential | Episode metadata; media only when permitted | GUID dedupe and removal policy | Local transcript for personal use |
| YouTube | Documented official API or user-owned import | User's project/API/OAuth credential | Only fields allowed by current policy | Implement policy refresh and deletion deadlines | Only authorized inputs |
| Bilibili | Documented open-platform capability or user import | User's platform credential | Capability-specific | Capability-specific | Only authorized inputs |
| Comments | Official API, open feed, JSON/CSV supplied by user | Source-specific | Minimal text, timestamp, source URL; no commenter profile | Propagate deletion/expiry | Aggregate insight with attribution |

Every shipping connector must add a reviewed row containing exact API method, terms version,
regional limits, retention window, attribution UI, and test fixtures before being enabled.
