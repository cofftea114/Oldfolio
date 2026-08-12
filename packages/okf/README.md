# @oldfolio/okf

OKF v0.2 parsing, validation, and new-document serialization for Oldfolio. The implementation targets upstream commit `374e0bc4c644310ff56cdf9c0fe81eccdec862b0`.

`parseOkfDocument(source, path)` is intentionally lossless: it returns the complete input, original frontmatter text, original Markdown body, and a normalized validation view. It never serializes or rewrites an existing document. Use `serializeNewOkfConcept` only when creating a new concept.

Reserved `index.md` and `log.md` files are classified separately from concepts. Bundle-root `index.md` may declare `okf_version`; other reserved documents may not carry frontmatter.
