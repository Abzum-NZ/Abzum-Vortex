# One-shot local preview runner

`tooling/fleet/local-preview.py` is a single-invocation local verifier for a caller-prepared worktree and exact full commit SHA. It owns the shared preview lock, the local reset/setup sequence, and one hidden Next.js process. A complete PASS also requires the separately maintained browser adapter; this runner alone never claims that a browser check passed.

## Boundaries

The runner accepts only a full 40- or 64-character SHA matching the worktree's current `HEAD`. It never fetches, checks out, cleans, stages, commits, or applies fixtures. Before any service action, it requires exactly two caller-prepared tracked changes, `apps/web/app/auth/sign-in/page.tsx` and `apps/web/next-env.d.ts`, plus the untracked local sign-in helper `apps/web/app/auth/dev-test-sign-in.ts`. The `next-env.d.ts` content must already contain the generated declaration expected for the installed Next.js development version; Next can rewrite this tracked file when its development server starts. Each of the three files' SHA-256 must match the caller's declaration. Staged changes, other tracked changes, and other non-ignored untracked files fail closed. Fixture preparation remains an explicit owner action. The runner never reverts or deletes these files; if Next changes a declared file to unexpected bytes, final fingerprint verification fails and leaves the resulting file for inspection.

The ignored `apps/web/.env.development.local` must exist in the supplied checkout and contain local loopback Supabase URL, local site URL, publishable key and identity authority settings. If set, `VORTEX_RUNTIME_DATABASE_URL` is checked as a PostgreSQL loopback URL on port 54322; other declared HTTP URL settings are checked separately. Next dev also loads `apps/web/.env.local`, `.env.development` and `.env` when present. The runner checks all four development dotenv sources and rejects service-role, secret-key or admin credential key names before starting Next. It checks parsed names and non-comment text, so alternate or ambiguous dotenv syntax cannot silently hide those names; the revised sign-in helper requires no admin key in the app. Env values are never included in the command log, result, or console output. An existing ignored `supabase/.temp/development-setup-state.json` blocks ordinary `preflight` and `run`: the runner will not remove or overwrite prior setup state, so use a fresh prepared checkout for a full run. Setup may create this file during a successful run, and it is left in place. The separate diagnostic modes require an exact completed setup-state hash and never reset or rerun setup. The runner requires an already-running local Supabase stack and checks its reported API URL is HTTP loopback on port 54321. It does not start, stop, or restart Supabase or Docker Desktop.

`run` requires `--confirm-reset-sha` to repeat the full candidate SHA. It first rejects a port already occupied by another process, then executes these bounded steps in order:

1. Recheck checkout and all three fixture fingerprints; refuse a pre-existing setup-state file; if given, read the PR once and require it to be open at the same SHA.
2. Run the repository's `tooling/supabase/ensure-local-signing-key.mjs` directly with the installed Node runtime before asking the Supabase CLI for status. The CLI reads the local signing-key file while parsing the config, so an unprepared checkout cannot report status. This step may create or reuse the ignored key file; `preflight` does not run it.
3. Check the already-running stack's local API URL, then run the installed, repository-pinned Supabase CLI entry point with `--yes db reset --local`. The explicit `--local` target is required; linked and database-URL targets are never used. The local stack must already be running. The [Supabase `db reset` reference](https://supabase.com/docs/reference/cli/supabase-db-reset) documents the local-target flag, and the [CLI global flags](https://supabase.com/docs/reference/cli/supabase) document `--yes`. An independent read-only help inspection confirmed those flags in the installed Supabase CLI 2.117.0; no reset was run. A later CLI version still needs its own compatibility check before execution, and an incompatible invocation fails with no fallback.
4. Read the local Auth service key from `supabase status --output json` into process memory and create a confirmed disposable local owner through the loopback Auth Admin endpoint. A randomly generated password is used only in memory and the owned web-server environment. The revised existing-user sign-in helper needs no service key, so the runner does not pass it to Next. The raw status output, service key, password and Auth response are never written to evidence.
5. Run the existing local setup script directly through Node from `apps/web` with `--local-development` and the supplied owner email.
6. Refuse an already occupied loopback web port, start the installed Next CLI bound to `127.0.0.1`, and require HTTP 200 from `/auth/sign-in` before its deadline. Next.js 16 forks its `start-server` worker; the runner accepts the listener only when OS process data proves it is the single direct child of the still-running invocation-owned CLI, with the expected Node executable, installed worker path and creation order. Any non-loopback or second listener on that port fails. It requires that same listener identity immediately before and after browser verification. Redirects are rejected on both the local Auth request and readiness probe. Standard output and error are discarded so application environment values cannot enter the runner log. The runner stops only the known CLI process tree. If its identity, worker exit or port release is uncertain, the run fails, preserves the lock and leaves the process for manual ownership review.
7. Invoke the explicitly supplied, SHA-pinned `.mjs` browser adapter with no credential arguments and require its structured result to match the candidate SHA, invocation nonce and all three fixture fingerprints. The adapter must independently validate its browser evidence. Required PASS checks are the original sign-in, CRM Companies list, New company and save flow plus the nine bounded Maia/default-theme checks described below. Its standard output is captured in memory with a 64 KiB limit and parsed even when the adapter exits nonzero; stderr is discarded. Only verified identity, known reason code, optional allowlisted action stage, fixed boolean checks, bounded theme metrics and cleanup attestation enter the structured result, never raw output. The adapter must positively attest that its owned browser tree exited and its private profile was removed. A missing, malformed or negative attestation keeps the shared lock for manual review. If a capture reader cannot finish after its bounded wait, the runner leaves the stream owned by that daemon reader instead of closing it from another thread, fails the step and keeps the lock.
8. Stop the owned server, then recheck the exact SHA, all three fixture fingerprints, the adapter fingerprint and optional PR head even when an earlier step failed. Write a structured result and JSONL step log outside the checkout. No uncertain browser, server, subprocess or capture-reader cleanup can produce PASS or release the lock. A browser result of FAIL or a nonzero adapter exit remains FAIL even with positive cleanup attestation.

Timeouts are bounded in the runner: auth preparation 120 seconds, Supabase status 60 seconds, local reset 600 seconds, owner creation 30 seconds, setup 900 seconds, server readiness 180 seconds, browser adapter 600 seconds, and owned-process shutdown 20 seconds. Every subprocess exit code and timeout state is recorded. No package manager is invoked and the runner never installs dependencies. The expected direct Supabase CLI command uses the documented global `--yes` and local-only `db reset --local` flags. The Next command follows the repository's existing `next dev -H 127.0.0.1` script and the official [`next dev` hostname and port options](https://nextjs.org/docs/app/api-reference/cli/next).

The exclusive lock is always in the current user's `~/.vortex-local-preview/local-preview.lock`, independent of the chosen `--state-dir`, so two worktrees cannot bypass one another by choosing different result directories. It is created atomically and never stolen or deleted automatically because of age. An uncertain process or capture reader, including a browser adapter that lacks positive cleanup attestation, keeps the lock even after a failed result is written; the owner must resolve process identity and the retained evidence before removing it. The result directory must be outside every checkout and writable only by the operator. Results include the exact checkout path, full SHA, declared fixture hashes, browser-adapter path and SHA-256, step exit codes, elapsed times, sanitized browser evidence, final identity checks and owned server PID. No credentials, raw process output, environment dump, local Auth response, or GitHub write is included. The PR identity is optional; if supplied, the runner performs one read-only head check before reset and one after browser verification or failure. It never creates, updates, polls, comments on, or merges a PR.

The canonical auth-key preparation script may create or reuse the shared ignored `supabase/.temp/signing-keys.json` in the main checkout and copy it into the prepared checkout's ignored `supabase/.temp/signing-keys.json`, as documented by that repository script. The runner does not remove either file. If a run fails after the database reset, the local database remains in its resulting state. A failed run does not restore database contents, revert fixtures, delete `.next`, or perform broad process cleanup.

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

The adapter writes exactly one JSON object to stdout and exits nonzero on any failure. A successful result has this schema; the pixel numbers below illustrate the shape and are not recorded measurements. The fixture map must exactly echo the runner's validated input:

```json
{"schema":"vortex.local-preview.browser.v1","result":"PASS","head_sha":"<full-sha>","run_nonce":"<same-nonce>","fixtures":{"apps/web/app/auth/sign-in/page.tsx":"<sha256>","apps/web/app/auth/dev-test-sign-in.ts":"<sha256>","apps/web/next-env.d.ts":"<sha256>"},"checks":{"sign_in":true,"companies_list":true,"new_company":true,"save_company":true,"maia_root":true,"maia_active_menu":true,"maia_table":true,"secondary_button":true,"customer_dimensions":true,"primary_rest":true,"primary_hover":true,"large_radius":true,"default_style_distinct":true},"theme_metrics":{"customer_computed_width_px":16,"customer_computed_height_px":16,"customer_rect_width_px":16,"customer_rect_height_px":16,"maia_table_header_padding_px":12,"maia_table_border_px":1,"maia_base_radius_px":14,"maia_menu_radius_px":18,"nova_base_radius_px":10,"nova_menu_radius_px":8},"action_stage":"complete","browser_cleanup":{"confirmed":true}}
```

A failure result uses `"result":"FAIL"`, a known machine-readable `reason`, completed boolean checks, any bounded metrics collected before failure, and `"browser_cleanup":{"confirmed":true|false}`. The adapter names its current `action_stage`: existing stages `not_started`, `sign_in`, `companies_list`, `new_company_click`, `company_create_route`, `company_name_control`, `customer_control`, `company_name_value`, `customer_value`, `save_control`, `save_confirmation`, `complete`, or the added theme stages `maia_root`, `maia_active_menu`, `maia_table`, `secondary_button`, `customer_dimensions`, `primary_rest`, `primary_hover`, `default_style_comparison`. The create-route stage waits for `/abzum/abzum/vortex.app.crm/crm_company_create` before checking the form controls. The runner retains a recognized stage only when candidate SHA, nonce and fixtures match; it omits an unknown or malformed value and records `action_stage_valid:false`. The safe `theme_check_failed` reason identifies a computed-style acceptance failure; neither raw CSS nor page content enters evidence. Stage reporting does not change cleanup or identity gates. The runner releases the lock after a failed browser check only if both the adapter process tree and browser cleanup are confirmed; the run still exits with FAIL.

For an identity-validated `FAIL` at `maia_active_menu` with reason `theme_check_failed`, the adapter may report one fixed `maia_active_menu_failed_predicate`: `wrong_route`, `root_count`, `root_theme`, `nav_item_count`, `current_link_count`, `link_not_visible`, `inactive_link`, `sidebar_scope`, `sentinel_resolution`, `menu_radius`, `base_radius`, `menu_background`, or `comparison_state`. The runner projects that value only after validating schema, exact SHA, nonce, fixture hashes, checks, reason, and cleanup-attestation shape. It records `maia_active_menu_failed_predicate_valid:false` if the optional value is absent, malformed, or appears in another context, and omits the value itself. This diagnostic cannot change PASS, browser cleanup, lock release, or final identity requirements; no raw page or style values are retained.

The nine additional fixed checks are `maia_root`, `maia_active_menu`, `maia_table`, `secondary_button`, `customer_dimensions`, `primary_rest`, `primary_hover`, `large_radius` and `default_style_distinct`. The runner accepts no unknown check name or non-boolean check value. `theme_metrics` contains only these pixel measurements: `customer_computed_width_px`, `customer_computed_height_px`, `customer_rect_width_px`, `customer_rect_height_px`, `maia_table_header_padding_px`, `maia_table_border_px`, `maia_base_radius_px`, `maia_menu_radius_px`, `nova_base_radius_px` and `nova_menu_radius_px`. Every supplied number must be finite and within 0..256. A check cannot be true when its corresponding measurement is absent or zero; `large_radius` additionally requires the Maia base radius to exceed Nova's and the rendered menu radii to differ. A PASS needs all thirteen checks true and all ten positive metrics. Failure may carry a validated partial metrics object. Invalid metrics fail the browser contract but cannot turn failure into PASS. The original four flow checks retain their meaning; a prior four-check adapter cannot satisfy this style acceptance. The existing diagnostic mode retains its separate `vortex.local-preview.diagnostic.v1` schema and `product_preview_pass:false`, even if every browser check passes.

The computed-style acceptance uses the definition-backed primary Save button, while New company remains secondary. The browser adapter owns actual hover, CSS resolution, Service Desk comparison and safe browser cleanup. A fresh visual walkthrough screenshot is still pending; this runner neither captures nor claims one from its JSON evidence.

At `FAIL` with `action_stage:"customer_control"`, the adapter may include a best-effort `customer_control_probe`. It has exactly eight integer counts from 0 to 1024: `form_count`, `group_count`, `checkbox_candidate_count`, `visible_candidate_count`, `customer_name_match_count`, `visible_customer_match_count`, `disabled_customer_match_count` and `visible_customer_label_count`, plus booleans `capped` and `scope_valid`. `capped` means at least one underlying count exceeded 1024. `scope_valid` is true only when exactly one Company form and one Company type group were found; otherwise the six group-scoped counts are zero, and `group_count` is zero when no unique form exists. The visible and Customer-match counts must also respect their parent candidate counts. The runner retains only this bounded object after validating the pinned adapter, result schema, exact SHA/nonce/fixtures, known failure reason, boolean checks and cleanup-attestation shape. An absent or malformed probe is omitted with `customer_control_probe_valid:false`. It cannot turn a failure into PASS or relax browser/process cleanup and lock handling; no text, HTML, values, URLs or element IDs enter evidence.

The separately tracked browser adapter is issue #1704 and is not included in this change. Until a reviewed compatible adapter is supplied by exact path and SHA-256, preflight/run cannot establish a complete browser PASS. The retired private `ui-smoke.mjs` and shell wrappers do not satisfy this contract and must not be invoked unchanged.

## Diagnose a completed local setup

`diagnose-preflight` is read-only. It checks the same candidate SHA, three fixture hashes, ignored local environment and adapter hash as ordinary preflight, then requires an existing regular Git-ignored `supabase/.temp/development-setup-state.json` with the declared SHA-256, `setupCompleted: true` and a valid `organizationId`. It hard-pins the reviewed existing-user-only sign-in helper to SHA-256 `0faeee5d13256b283bacc71688add055b29bed58f5d9049e0f209e84580fd987`. The earlier helper that issued an Auth Admin create-user request is rejected. It reads the already-running loopback Supabase status and scans at most ten bounded Auth Admin pages to require exactly one user with the literal email `codex-preview@vortex.test`. Local Auth may report its internal `/admin/users` path in a pagination Link; the runner validates that or the external `/auth/v1/admin/users` path without following either. Contradictory pagination links, including a later advertised page beyond an empty terminal page, fail closed. It reports only that user's UUID, not any credential or raw Auth response. A missing signing-key file can make the installed Supabase CLI status fail; this read-only mode does not prepare one.

After independent review and an explicit local-preview grant, `diagnose-existing` repeats those checks under the same canonical preview lock. The operator must pass the exact preflight UUID twice, through `--owner-id` and `--confirm-rotate-owner-id`. The runner uses the local Auth Admin **PUT by ID** endpoint to replace only that disposable user's password with an in-memory random value, and verifies the returned UUID and literal email. It does not create or delete users, reset the database, or run setup. The private Next child receives the password for existing-user login but no service-role key. The pinned browser adapter may save at most one disposable local CRM company. The runner reuses the full run's owned Next listener checks, pinned adapter evidence and browser-cleanup attestation, bounded subprocess handling, final candidate/fixture/adapter checks, and canonical lock behavior. High-level diagnostic orchestration is separate so it cannot enter the full run's reset/setup path. It also rechecks the setup-state hash and disposable user identity after browser verification.

The diagnostic result uses `vortex.local-preview.diagnostic.v1`, `status: DIAGNOSTIC_COMPLETE` on success, and `product_preview_pass: false` even if all four browser checks pass. It cannot be accepted as a full product-preview PASS. Failure, missing cleanup attestation, uncertain process identity, or changed final fingerprints fail closed; uncertain cleanup retains the canonical lock. Diagnostic evidence and step logs use `local-diagnostic-<nonce>` names in the external state directory. The setup state, fixture files and any earlier preview evidence are preserved.

Use the same absolute `--checkout`, `--sha`, `--web-env-file`, three fixture hash arguments, `--browser-adapter`, `--browser-adapter-sha256`, `--port` and `--owner-email codex-preview@vortex.test` arguments shown above for both diagnostic commands. Add these mode-specific arguments:

```powershell
python tooling/fleet/local-preview.py diagnose-preflight <shared-arguments> `
  --setup-state-sha256 <completed-setup-file-sha256>

python tooling/fleet/local-preview.py diagnose-existing <shared-arguments> `
  --setup-state-sha256 <same-completed-setup-file-sha256> `
  --owner-id <exact-uuid-from-diagnose-preflight> `
  --confirm-rotate-owner-id <same-uuid> `
  --state-dir C:\Users\you\AppData\Local\Abzum-Vortex\local-diagnostic
```

An operator must not treat a prior diagnostic preflight as permission to run: the live mode changes the disposable user's local password and may save a company. It requires a separate grant of the shared local preview resource.
