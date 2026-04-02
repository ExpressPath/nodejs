# CIC Strategy

This project is moving toward exact CIC-oriented exports instead of the current pretty-printed typed-lambda envelope.

## What we can use for free

There is no free hosted API in this repo today, and we did not identify a stable free hosted API for exact Lean/Coq-to-CIC export in the sources checked.

The realistic free path is local toolchains and open-source exporters.

## Coq / Rocq

Recommended exact route:

- MetaRocq / Template-Rocq for quotation based on the kernel term representation
- MetaRocq PCUIC as the cleaned-up calculus equivalent to Rocq's term language

Useful sources:

- https://github.com/MetaRocq/metarocq

Why:

- Template-Rocq quotes Rocq terms to a syntax tree based on the kernel representation.
- PCUIC is presented there as a cleaned-up version of Rocq's term language and associated type system.

## Lean

Recommended exact route:

- `lean4export` to export elaborated declarations and `Expr`
- build a `cic-v1` translator from the exported expression graph for the quotient-free fragment

Useful sources:

- https://github.com/leanprover/lean4export
- https://raw.githubusercontent.com/leanprover/lean4export/master/format_ndjson.md
- https://github.com/digama0/lean4lean

Why:

- `lean4export` exports declaration and expression primitives such as `sort`, `const`, `app`, `lam`, `forallE`, `letE`, `proj`, plus declarations.
- `lean4lean` is an implementation of the Lean 4 kernel in Lean, which is useful as a correctness reference.

Important limitation:

- the Lean export format also includes quotient declarations, so exact export of all Lean code to plain CIC is not automatic
- for exactness, we either restrict to a CIC-like fragment or explicitly encode Lean-specific features

## Alternate bridge

If we need a shared external proof language before a custom `cic-v1` is ready:

- Lean to Dedukti: https://github.com/Deducteam/lean2dk
- Coq to Dedukti: https://github.com/Deducteam/CoqInE
- Dedukti checker: https://github.com/Deducteam/Dedukti

This is useful because both ecosystems already have open-source translators there, but the target is lambda-Pi modulo rather than plain CIC.

## Current state in this repo

- `tools/convert-lean.cjs` uses `#print` and `#check`
- `tools/convert-coq.cjs` uses `Print` and `Check`
- `tools/convert-lean-cic.cjs` now decodes `lean4export` NDJSON into a `cic-v1` JSON tree for a quotient-free fragment
- `tools/convert-coq-cic.cjs` is currently an adapter wrapper around an exact external exporter command
- `lib/cic-normalizer.js` now normalizes both Lean- and Coq-side CIC payloads into one shared `cic-v1` schema

These are helpful proof-term exports, but they are not exact CIC converters.

## Shared normalized schema

The current common target is a JSON `cic-v1` envelope with:

- `format`
- `schemaVersion`
- `theoremName`
- `term`
- `context`
- `declarations`
- `metadata.normalization`

The normalized term layer currently understands these common constructors:

- `rel`
- `var`
- `sort`
- `const`
- `ind`
- `construct`
- `app`
- `lambda`
- `prod`
- `let`
- `cast`
- `proj`
- `case`
- `fix`
- `cofix`
- `evar`
- `lit`

If an upstream exporter uses a constructor that is not mapped yet, the normalizer preserves it as `raw` / `raw-level` / `raw-text` and records counts in `metadata.normalization`.
