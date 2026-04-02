# Railway Helper API

This helper server is intended to cooperate with the main `iVucx` app:

- proof checking can be delegated to the Render-hosted `iVucx` deployment
- conversion and submit can also be delegated to the Render-hosted `iVucx` deployment
- Railway stays responsible for helper routing, auth, jobs, and lightweight orchestration

## What it does

- `GET /healthz`
- `GET /readyz`
- `GET /api/helper/info`
- `POST /api/helper/check`
- `POST /api/helper/submit`
- `POST /api/helper/convert`
- `POST /api/helper/jobs`
- `GET /api/helper/jobs/:id`
- `GET /api/helper/jobs/:id/result`
- `DELETE /api/helper/jobs/:id`

`GET /api/helper/info` also exposes the supported async job types:

- `proof-check`
- `lambda-convert`
- `submit`

## Recommended deployment split

- `Render` hosts `iVucx` itself and runs Lean / Coq proof checking plus heavy conversion work
- `Railway` hosts this helper and runs lightweight helper routing plus job storage

When you set `EXECUTION_SERVER_BASE_URL`, point it at the public base URL of the Render-hosted `iVucx` app.

Important:

- the execution delegate now uses:
  - `/api/helper/check` for proof checking
  - `/api/proof-convert` for conversion and submit
- the Railway Docker image is intentionally slim and no longer builds Lean / Rocq toolchains
- this keeps heavy theorem-prover builds on Render, where the main `iVucx` app already needs them
- for the slim image, `EXECUTION_SERVER_BASE_URL` should be set

## Local converter commands

If you explicitly want a local fallback outside the recommended split, set `LEAN_LAMBDA_CMD` / `COQ_LAMBDA_CMD` (and optionally the CIC variants) yourself and install the corresponding toolchains in your own image.

- `tools/convert-lean.cjs`
- `tools/convert-coq.cjs`

They use Lean / Coq themselves to print elaborated proof terms and normalize the result into a shared JSON envelope, but the default Railway image no longer ships those toolchains.

## CIC direction

This server can also be configured with exact-export commands for a `cic-v1` target.

- `LEAN_CIC_CMD`
- `LEAN_CIC_ARGS`
- `LEAN_CIC_STDOUT_FORMAT`
- `LEAN_CIC_RESULT_FORMAT`
- `COQ_CIC_CMD`
- `COQ_CIC_ARGS`
- `COQ_CIC_STDOUT_FORMAT`
- `COQ_CIC_RESULT_FORMAT`
- `LEAN4EXPORT_CMD` or `IVUCX_LEAN_EXPORTER_CMD`
- `LEAN4EXPORT_ARGS` or `IVUCX_LEAN_EXPORTER_ARGS`
- `LEAN4EXPORT_BIN` or `IVUCX_LEAN_EXPORTER_BIN`
- `COQ_CIC_EXPORT_CMD` or `IVUCX_COQ_CIC_EXPORT_CMD`
- `COQ_CIC_EXPORT_ARGS` or `IVUCX_COQ_CIC_EXPORT_ARGS`

Important:

- the bundled `tools/convert-lean-cic.cjs` uses `lake env <lean4export> <module>` and currently targets a quotient-free `cic-v1` fragment
- the bundled `tools/convert-coq-cic.cjs` has a built-in MetaRocq export path and still accepts an external exact exporter via `COQ_CIC_EXPORT_CMD`
- both Lean and Coq CIC paths are normalized through `lib/cic-normalizer.js` into the same `cic-v1` schema
- normalized results now include `schemaVersion` and `metadata.normalization`
- the bundled `tools/convert-lean.cjs` and `tools/convert-coq.cjs` are not exact CIC exporters
- `format: "cic-v1"` should only be used when the CIC converters above are configured
- see `CIC_STRATEGY.md` for the researched exact path

## Auth

If `HELPER_API_KEY` is set, helper endpoints require one of the following.

- `Authorization: Bearer <key>`
- `X-Helper-Key: <key>`

## Docker

Build:

```bash
docker build -t railway-helper-api .
```

Run:

```bash
docker run --rm -p 3000:3000 \
  -e HELPER_API_KEY=change-me \
  railway-helper-api
```

You can also start from:

- `.env.example`

## Example convert payload

```json
{
  "language": "Lean",
  "fileName": "Main.lean",
  "verify": true,
  "format": "typed-lambda-v1",
  "code": "theorem t : True := by trivial",
  "async": true
}
```

## Notes

- Async jobs are stored as JSON in `data/jobs`.
- On Railway, attach a volume and point `JOBS_DIR` at that mount if you want jobs to survive deploys.
- The current built-in converters prioritize accuracy of the proof term exported by Lean / Coq themselves. They are not yet a full kernel-level cross-language equivalence checker.
