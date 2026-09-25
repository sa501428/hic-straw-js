# ADR-0002 — Isolated `.hic` v10 reader

**Status:** Accepted
**Date:** 2026-09-24

## Context

`.hic` v10 is a new wire format rather than an extension of v9. It replaces the
top-level header and footer, matrix directory, block index, compression codec,
logical block encodings, and vector storage. It also introduces exactly derived
matrix resolutions and unsigned 64-bit counts.

Adding version checks throughout the legacy parser would couple unrelated binary
layouts and make regressions in versions 5–9 difficult to contain.

## Decision

`HicFile` remains the compatibility facade. It sniffs the first eight bytes and
routes v10 files to `src/v10/hicFile.js`; versions 5–9 continue through the
existing parser in `src/hicFile.js`. The v10 implementation owns strict binary
parsing, exact block geometry, Zstandard decoding, derived aggregation, and
chunked normalization and expected-value vectors.

V10 counts are held internally as `BigInt`. Public raw counts at or below
`Number.MAX_SAFE_INTEGER` are converted to numbers for compatibility; larger
counts remain `bigint`. Normalized values and stored scores are numbers.

Zstandard decoding uses `zstddec`, wrapped by a format-specific validator that
requires one ordinary frame, rejects preset dictionaries and trailing frames,
checks the declared output length, and leaves checksum validation to the
reference decoder.

All v10 locators are validated against the byte source's total size. Built-in
sources expose `getSize()`; custom v10 sources must expose `getSize()`, `size`, or
be paired with `config.fileSize`.

## Consequences

- Legacy parsing and behavior remain isolated.
- Browser and Node builds use the `zstddec` dependency, whose WebAssembly decoder
  is embedded in its JavaScript module and requires no separately deployed asset.
- Consumers serializing raw v10 contacts must handle `bigint` counts explicitly.
- Raw and normalized expected vectors are available through the facade, and v10
  contact queries support observed, expected, and observed/expected values.
