# Railway Helper API

This helper server accepts Lean and Coq proof-check requests and proof-term conversion requests from the main site.

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

## Built-in converter commands

If `LEAN_LAMBDA_CMD` / `COQ_LAMBDA_CMD` are not set, the server uses the bundled converters below.

- `tools/convert-lean.cjs`
- `tools/convert-coq.cjs`

They use Lean / Coq themselves to print elaborated proof terms and normalize the result into a shared JSON envelope.

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
