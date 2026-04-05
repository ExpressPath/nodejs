# ivucx Railway Helper

This helper service is the lightweight planner/orchestrator in the split deployment.

## Role Split

- `Supabase`
  - stores users, jobs, conversion plans, and saved problems
- `Railway`
  - accepts helper API requests
  - creates conversion plans
  - loads only the metadata needed for execution
  - calls the Render-hosted `iVucx` app for heavy proof checking / conversion
  - stores final results back into Supabase
- `Render`
  - runs Lean / Coq proof checking
  - runs `typed-lambda-v1` and `cic-v1` conversion

## Required Environment Variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EXECUTION_SERVER_BASE_URL`

Accepted aliases:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Optional:

- `HELPER_API_KEY`
- `EXECUTION_SERVER_API_KEY`
- `EXECUTION_SERVER_TIMEOUT_MS`
- `EXECUTION_SERVER_CONVERT_ROUTE`
- `EXECUTION_SERVER_LEAN_CHECK_ROUTE`
- `EXECUTION_SERVER_COQ_CHECK_ROUTE`
- `HELPER_MAX_CODE_BYTES`

## Routes

- `GET /healthz`
- `GET /api/helper/info`
- `POST /api/helper/check`
- `POST /api/helper/submit`
- `POST /api/helper/convert`
- `GET /api/helper/jobs`
- `GET /api/helper/jobs/:id`
- `GET /api/helper/jobs/:id/result`
- `DELETE /api/helper/jobs/:id`

## Notes

- This Railway image intentionally does not include Lean / Coq toolchains.
- Heavy conversion work is delegated to the Render-hosted `iVucx` service.
- Apply `supabase/proof_helper.sql` from the main repo before using the planner-backed flow.
- BlueMode client UI may expose only public values like `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- The helper planner still needs a server-side service-role key and cannot bootstrap that key from browser state.
