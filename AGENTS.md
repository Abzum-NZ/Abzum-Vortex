# Vortex agent instructions

Read [agent coordination](docs/build-plan/agent-coordination.md) (policy) and [fleet operations](docs/build-plan/agent-fleet.md) (procedure) before planning, dispatching, implementing or reviewing. They are the current fleet rules. The latest direct instruction from the owner overrides them; old runbooks, checkpoints and issue comments do not.

## Non-negotiables for every agent

- **Roles** (owner decision, 27 September 2026):
  - GPT-6 Sol (Codex) at **High** effort is the main orchestrator;
  - Claude Opus 5.5 does **planning only** (issue shaping, architecture options, design records);
  - GPT-6 Luna (Codex) at **Extra High** effort implements;
  - GPT-6 Sol (Codex) at **Extra High** effort reviews and fixes, always in a different session from the implementer.
- **Codex lanes are headless** (`codex exec`), never interactive daemon-backed Codex terminals, which open a console window per command on Windows.
- **Never push to main.** Every change reaches main through a pull request; main is protected, including for administrators. Create branches with `--no-track` and push with an explicit refspec (`git push origin HEAD:refs/heads/<branch>`).
- **Verify before merge** exactly as [agent coordination](docs/build-plan/agent-coordination.md#verification-before-merge) says. The checks are scoped and fast; they are not tests, and no agent creates, edits or runs tests.
- **English only** in code, comments, strings, commits, PRs, issue comments, board fields and documents. Rewrite any non-English text before committing.
- **Database functions:** every migration that creates or changes a database function carries its complete `create or replace function` body, identical to its canonical file `supabase/schemas/<schema>/<function>.sql` (with comment and grants) changed in the same commit; a signature change is an explicit `drop function` then `create`. Never read a stored definition with `pg_get_functiondef`, `prosrc` or `routine_definition`, and never patch one with `replace()`. `pnpm boundaries` enforces this ([supabase/schemas/README.md](supabase/schemas/README.md)). Migration numbers come from the orchestrator and sort after every migration on `origin/main`.
- **Product integrity:** preserve tenant isolation, permissions, transactions, revisions, safe errors and explicit publication and installation. Fix obsolete contracts at their root; this is a new application with no legacy compatibility. Never put business application names or special cases into generic engines. Never expose credentials. Preserve unique work before any cleanup.
- **Respect real controls.** A tool-approval or repository-protection rejection is reported with its exact cause, never retried unchanged or routed around. A provider capacity or rate-limit response is not a denial: retry the same session a few times about 20 seconds apart before reassigning.
- **No hosted work:** no Kestra runs, Testing or Production deployment, or hosted verification.
