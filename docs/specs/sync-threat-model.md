# WebDAV encrypted sync threat model

## Promise

Oldfolio protects the confidentiality and integrity of remote WebDAV objects. It does not promise
remote availability, metadata invisibility, or recovery when both every authorized device and the
offline recovery phrase are lost.

The provider can observe account identity, IP address, request timing, ciphertext sizes, and object
counts. It can delete or hide objects. Existing devices use a signed manifest chain to detect
tampering and many rollback attempts; a brand-new device without a trusted head cannot prove that
the provider served the newest state.

## Key hierarchy

- Each vault receives a random 256-bit master key independent of the WebDAV password.
- Per-epoch encryption keys derive from the master key with domain separation.
- Object encryption uses an audited AEAD construction with unique random nonces and authenticated
  object metadata.
- A recovery-key envelope protects the master key. The recovery phrase is displayed once and is
  never sent to Oldfolio.
- Device pairing transfers an encrypted envelope directly using a short-lived pairing secret.

Revocation rotates future epoch keys. It cannot erase plaintext or prior keys already obtained by
the revoked device. Users must also rotate WebDAV credentials if that device knew them.

## Remote protocol

Remote storage contains content-addressed ciphertext, encrypted manifests, tombstones, and the
signed head. Publishing uses conditional `If-Match`; `412` triggers download and merge rather than
retrying an overwrite. Uploads are idempotent and large objects are resumable.

Cryptographic code in this repository is an interoperability prototype until an external review
marks the protocol production-ready.
