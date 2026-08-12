# Oldfolio profile for OKF v0.2

Oldfolio's strict knowledge bundles target OKF v0.2 at upstream baseline
`374e0bc4c644310ff56cdf9c0fe81eccdec862b0`.

Native Markdown under `notes/` is not claimed to be OKF. Strict conformance applies only beneath
registered roots in `bundles/`. Consumers preserve unknown frontmatter keys and tolerate unknown
types and broken links as required by OKF.

## Profile fields

Every non-reserved concept contains:

```yaml
type: Concept
title: Example
oldfolio:
  id: 019ff623-bfc1-70b1-9d51-7596c128d152
```

`oldfolio.id` is a UUID and survives path changes. Profile types are `Source`, `Transcript`,
`Concept`, `Creator`, `Perspective`, `Audience Insight`, and `Synthesis`. Producers use OKF
`sources`, `generated`, `verified`, `status`, and `stale_after` without shadow equivalents.

## Ownership

- Humans and imports append source revisions to `raw/`; AI cannot edit existing raw revisions.
- The wiki compiler may create drafts and propose changes in `wiki/`.
- Human-authored notes are changed only by L3 approval.
- `index.md` is a progressive directory and `log.md` is a newest-first ISO-date history.

## Cross-bundle links

Internal files use normal Markdown links. A cross-bundle reference uses a vault-relative Markdown
path plus `oldfolio.id` in the resolved target. Portable export copies reachable dependencies into
the exported bundle and rewrites links; unresolved external concepts remain legal broken links.
