# One-shot local preview runner

`tooling/fleet/local-preview.py` is a single-invocation local verifier for a caller-prepared worktree and exact full commit SHA. It owns the shared preview lock, the local reset/setup sequence, and one hidden Next.js process. A complete PASS also requires the separately maintained browser adapter; this runner alone never claims that a browser check passed.

## Boundaries

The runner accepts only a full 40- or 64-character SHA matching the worktree's current `HEAD`. It never fetches, checks out, cleans, stages, commits, or applies fixtures. Before any service action, it requires exactly two caller-prepared tracked changes, `apps/web/app/auth/sign-in/page.tsx` and `apps/web/next-env.d.ts`, plus the untracked local sign-in helper `apps/web/app/auth/dev-test-sign-in.ts`. The `next-env.d.ts` content must already contain the generated declaration expected for the installed Next.js development version; Next can rewrite this tracked file when its development server starts. Each of the three files' SHA-256 must match the caller's declaration. Staged changes, other tracked changes, and other non-ignored untracked files fail closed. Fixture preparation remains an explicit owner action. The runner never reverts or deletes these files; if Next changes a declared file to unexpected bytes, final fingerprint verification fails and leaves the resulting file for inspection.

The ignored `apps/web/.env.development.local` must exist in the supplied checkout and contain local loopback Supabase URL, local site URL, publishable key and identity authority settings. If set, `VORTEX_RUNTIME_DATABASE_URL` is checked as a PostgreSQL loopback URL on port 54322; other declared HTTP URL settings are checked separately. Env values are never included in the command log, result, or console output. An existing ignored `supabase/.temp/development-setup-state.json` blocks preflight and run: the runner will not remove or overwrite prior setup state, so use a fresh prepared checkout if it exists. Setup may create this file during a successful run, and it is left in place. The runner requires an already-running local Supabase stack and checks its reported API URL is HTTP loopback on port 54321. It does not start, stop, or restart Supabase or Docker Desktop.

`run` requires `--confirm-reset-sha` to repeat the full candidate SHA. It first rejects a port already occupied by another process, then executes these bounded steps in order:

1. Recheck checkout and all three fixture fingerprints; refuse a pre-existing setup-state file; if given, read the PR once and require it to be open at the same SHA.
2. Run the repository's `tooling/supabase/ensure-local-signing-key.mjs` directly with the installed Node runtime.
3. Run the installed, repository-pinned Supabase CLI entry point with `--yes db reset --local`. The explicit `--local` target is required; linked and database-URL targets are never used. The local stack must already be running. The [Supabase `db reset` reference](https://supabase.com/docs/reference/cli/supabase-db-reset) documents the local-target flag, and the [CLI global flags](https://supabase.com/docs/reference/cli/supabase) document `--yes`. An independent read-only help inspection confirmed those flags in the installed Supabase CLI 2.117.0; no reset was run. A later CLI version still needs its own compatibility check before execution, and an incompatible invocation fails with no fallback.
4. Read the local Auth service key from `supabase status --output json` into process memory and create a confirmed disposable local owner through the loopback Auth Admin endpoint. A randomly generated password is used only in memory and the owned web-server environment. The raw status output, service key, password and Auth response are never written to evidence.
5. Run the existing local setup script directly through Node from `apps/web` with `--local-development` and the supplied owner email.
6. Refuse an already occupied loopback web port, start the installed Next CLI bound to `127.0.0.1`, and require HTTP 200 from `/auth/sign-in` before its deadline. Next.js 16 forks its `start-server` worker; the runner accepts the listener only when OS process data proves it is the single direct child of the still-running invocation-owned CLI, with the expected Node executable, installed worker path and creation order. Any non-loopback or second listener on that port fails. It requires that same listener identity immediately before and after browser verification. Redirects are rejected on both the local Auth request and readiness probe. Standard output and error are discarded so application environment values cannot enter the runner log. The runner stops only the known CLI process tree. If its identity, worker exit or port release is uncertain, the run fails, preserves the lock and leaves the process for manual ownership review.
7. Invoke the explicitly supplied, SHA-pinned `.mjs` browser adapter with no credential arguments and require its structured result to match the candidate SHA, invocation nonce and all three fixture fingerprints. The adapter must independently validate its browser evidence. Required results are sign-in, CRM Companies list, New company and save. Its standard output is captured in memory with a 64 KiB limit, parsed, and never persisted verbatim; stderr is discarded. If a capture reader cannot finish after its bounded wait, the runner leaves the stream owned by that daemon reader instead of closing it from another thread, fails the step, and records that process-tree shutdown could not be confirmed.
8. Stop the owned server, then recheck the exact SHA, all three fixture fingerprints, the adapter fingerprint and optional PR head. Write a structured result and JSONL step log outside the checkout. A cleanup or capture-reader uncertainty is FAIL and keeps the lock for manual review.

Timeouts are bounded in the runner: auth preparation 120 seconds, Supabase status 60 seconds, local reset 600 seconds, owner creation 30 seconds, setup 900 seconds, server readiness 180 seconds, browser adapter 600 seconds, and owned-process shutdown 20 seconds. Every subprocess exit code and timeout state is recorded. No package manager is invoked and the runner never installs dependencies. The expected direct Supabase CLI command uses the documented global `--yes` and local-only `db reset --local` flags. The Next command follows the repository's existing `next dev -H 127.0.0.1` script and the official [`next dev` hostname and port options](https://nextjs.org/docs/app/api-reference/cli/next).

The exclusive lock is always in the current user's `~/.vortex-local-preview/local-preview.lock`, independent of the chosen `--state-dir`, so two worktrees cannot bypass one another by choosing different result directories. It is created atomically and never stolen or deleted automatically because of age. An uncertain process or capture reader keeps the lock even after a failed result is written; the owner must resolve process identity and the retained evidence before removing it. The result directory must be outside every checkout and writable only by the operator. Results include the exact checkout path, full SHA, declared fixture hashes, browser-adapter path and SHA-256, step exit codes, elapsed times, browser evidence and owned server PID. No credentials, raw process output, environment dump, local Auth response, or GitHub write is included. The PR identity is optional; if supplied, the runner performs one read-only head check before reset and one after browser verification. It never creates, updates, polls, comments on, or merges a PR.

The canonical auth-key preparation script may create or reuse the shared ignored `supabase/.temp/signing-keys.json` in the main checkout, as documented by that repository script. The runner does not remove it. If a run fails after the database reset, the local database remains in its resulting state. A failed run does not restore database contents, revert fixtures, delete `.next`, or perform broad process cleanup.

## Commands

All paths are absolute. `plan` validates only the checkout root and full SHA and prints the order without starting any service. `preflight` is read-only: it verifies the supplied fixture and browser-adapter fingerprints, local ignored environment-file presence, installed entry-point paths, checkout status and optional PR identity shape. Neither command resets a database, runs setup, starts a server, or launches a browser.

```powershell
python tooling/fleet/local-preview.py plan `
  --checkout C:\work\candidate `
  --sha <full-commit-sha>

python tooling/fleet/local-preview.py preflight `
  --checkout C:\work\candidate `
  --sha <full-commit-sha> `
  --web-env-file C:\work\candidate\apps\web\.env.development.local `
  --fixture-page-sha256 <prepared-page-sha256> `
  --fixture-helper-sha256 <prepared-helper-sha256> `
  --fixture-next-env-sha256 <prepared-next-env-sha256> `
  --browser-adapter C:\Users\you\AppData\Local\Abzum-Vortex\local-preview\local-preview-browser.mjs `
  --browser-adapter-sha256 <reviewed-adapter-sha256> `
  --owner-email owner@vortex.test
```

Only after independent review and explicit lead assignment of the shared preview resource may an authorized operator run the same inputs with a stable per-user state directory and a SHA-bound reset confirmation:

```powershell
python tooling/fleet/local-preview.py run `
  --checkout C:\work\candidate `
  --sha <full-commit-sha> `
  --confirm-reset-sha <same-full-commit-sha> `
  --web-env-file C:\work\candidate\apps\web\.env.development.local `
  --fixture-page-sha256 <prepared-page-sha256> `
  --fixture-helper-sha256 <prepared-helper-sha256> `
  --fixture-next-env-sha256 <prepared-next-env-sha256> `
  --browser-adapter C:\Users\you\AppData\Local\Abzum-Vortex\local-preview\local-preview-browser.mjs `
  --browser-adapter-sha256 <reviewed-adapter-sha256> `
  --owner-email owner@vortex.test `
  --state-dir C:\Users\you\AppData\Local\Abzum-Vortex\local-preview
```

An optional `--pr-repo OWNER/REPO --pr-number N` binds the two read-only GitHub head checks to the declared SHA. The browser adapter receives these environment variables and no credentials:

```text
VORTEX_PREVIEW_BASE_URL       HTTP loopback origin with explicit port
VORTEX_PREVIEW_HEAD_SHA       full candidate SHA
VORTEX_PREVIEW_RUN_NONCE      unique invocation ID
VORTEX_PREVIEW_FIXTURE_FINGERPRINTS  compact JSON map of relative paths to SHA-256
```

The adapter writes exactly one JSON object to stdout and exits nonzero on any failure. A successful result has this schema; the fixture map must exactly echo the runner's validated input:

```json
{"schema":"vortex.local-preview.browser.v1","result":"PASS","head_sha":"<full-sha>","run_nonce":"<same-nonce>","fixtures":{"apps/web/app/auth/sign-in/page.tsx":"<sha256>","apps/web/app/auth/dev-test-sign-in.ts":"<sha256>","apps/web/next-env.d.ts":"<sha256>"},"checks":{"sign_in":true,"companies_list":true,"new_company":true,"save_company":true}}
```

The separately tracked browser adapter is issue #1704 and is not included in this change. Until a reviewed compatible adapter is supplied by exact path and SHA-256, preflight/run cannot establish a complete browser PASS. The retired private `ui-smoke.mjs` and shell wrappers do not satisfy this contract and must not be invoked unchanged.
