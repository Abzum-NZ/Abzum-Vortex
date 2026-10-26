# Vortex: working instructions

Vortex builds business applications from versioned definitions (modules, record types, fields,
relationships, pages, permissions, actions, flows, connections, themes). Generic engines and a
Next.js application render and execute those definitions for many organisations, with access
enforced by the platform and the database.

Operating procedure (roles, coordination, launch, review, reporting):
C:/Users/vijay/Documents/Codex/2026-10-24/task-5/vortex-orca-operating-manual.md. Read it before
starting work; your launch spec names your role.

## One way only

Vortex is a fresh project with no backward compatibility. Every concern has exactly one format, one contract and one code path. Replace contracts and formats in place, convert shipped definitions in the same change, and rebuild existing data with a forward migration. Do not add converters, upgraders, dual readers, compatibility branches, legacy mirrors, or a second way of doing something that already has one. When you find two ways, remove one.

## Layout

| Path                   | Contents                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| `apps/web`             | Next.js application and local development setup                                 |
| `packages/platform`    | Domain schemas, server operations and database access                           |
| `packages/ui`          | Shared components and the designer                                              |
| `packages/definitions` | Shipped application and module definitions                                      |
| `supabase`             | Config, `schemas/` (canonical function files), `migrations/`, seed              |
| `workflows/kestra`     | Operational flows and scripts                                                   |
| `tooling`              | Development tools (catalogue, style and font emitters, local database helpers)  |
| `docs`                 | Specification (`docs/specification`), roadmap and decisions (`docs/build-plan`) |

## Run locally

```
pnpm install
pnpm db:start      # local Supabase
pnpm db:reset      # apply migrations and seed (destructive: a fresh clone only)
pnpm setup:local   # provision the development organisation and install modules
pnpm dev
```

Environment variables are described in `README.md` and `apps/web/.env.example`.
`pnpm verify` runs format check, lint, typecheck and build.
`pnpm guard` blocks new architecture violations and reports the remaining checks as warnings.

## Local database lanes

Local development runs on lanes: lighter Local Supabase stacks (no Studio, logs or edge runtime)
under `VORTEX_LANES_ROOT` (default `A:/Apps/vortex-lanes`), each with every port of
`supabase/config.toml` shifted per lane. `node tooling/supabase/lane.mjs` lists the lanes this
host supports and their ports. Use only the lane you were given.

Lanes are disposable. Each lane has one holder. Reset only a lane you hold (`lane.mjs reset`,
`pnpm db:reset` or `pnpm demo:setup`, which always resets its target database); never reset
another agent's lane. When `main` moves, forward migrate the lane or reset it. To set up without a
reset, run `pnpm --filter @vortex/web demo:owner` and then `pnpm setup:local --
--local-development --first-owner-identity-id <uuid>` with the printed identity and without
`--seed-demo`.

```
node tooling/supabase/lane.mjs init <n>     # once: generate the lane config
node tooling/supabase/lane.mjs start <n>    # start the lane (stop <n> stops only that lane)
node tooling/supabase/lane.mjs env <n>      # lines for apps/web/.env.development.local
node tooling/supabase/lane.mjs sync <n> .   # mirror this worktree's migrations and seed, no reset
node node_modules/supabase/dist/supabase.js migration up --include-all --local --workdir <lane directory>  # forward migrate
node tooling/supabase/lane.mjs reset <n> .  # destructive: mirror migrations and seed, then reset (your lane only)
VORTEX_SUPABASE_WORKDIR=<lane directory> pnpm demo:setup  # destructive: resets, then seeds (your lane only)
```

`env` prints `VORTEX_SUPABASE_URL`, `VORTEX_SUPABASE_PUBLISHABLE_KEY`,
`VORTEX_RUNTIME_DATABASE_URL`, `VORTEX_DEV_SERVICE_ROLE_KEY`, `VORTEX_SUPABASE_WORKDIR` and
`VORTEX_EVENT_DELIVERY_MODE=in_process`; put them in the worktree's ignored
`apps/web/.env.development.local`, never in a tracked file or a log. With
`VORTEX_SUPABASE_WORKDIR` set, the demo and development setup scripts pass `--workdir` to every
Supabase CLI call. `status <n>` shows the lane's URLs and keys.

## Rules

The [target architecture](docs/build-plan/target-architecture.md) is binding: read it before changing code. In short:

- English only, in code, comments, documents and commit messages.
- Work on a branch and open a pull request to `main`. Never push to `main`.
- No automated tests are written or run (owner decision). Do not add test files, test runners or test dependencies.
- The UI is definition-driven: frame, navigation, layout, pages and theme come from definitions.
  Engines only render. Do not hard-code a shell, navigation or theme in an engine.
- Generic engines never name business applications (CRM, Service Desk and so on).
- Migrations: add a new numbered file under `supabase/migrations`; never edit an applied one.
  When a database function changes, its canonical file in `supabase/schemas` and the migration
  must hold the identical definition.
- Tenant and organisation isolation, current permission checks, atomic writes, revision checks and
  safe errors are product requirements. Preserve them in every change.
- Keep secrets out of files, prompts and logs.
- Packages use each other's public interfaces only; nothing depends upward.
- One renderer: pages are Puck data rendered with the one Puck config built on shadcn/ui. No other
  code path draws a block.
- Reads serve the visible page first. Studio preview may continue an idle background fill after
  visible reader demand is satisfied; never prefetch speculatively before it.
  This follows the owner's paging rule: background fill continues only after the visible page's
  requested data is served.
- No absent-setting behaviour: defaults live in definitions (Puck `defaultProps`), not in renderers.
- One current version of every contract: no `V2`/`V3` copies.
- One record write path (`apply_record_changes`), one activity append, one idempotency table.
- No process artefacts in product code: no review receipts, fingerprints, continuity or evidence.
- Fail loudly on platform-produced data: never turn a parse failure or database error into a silent
  `null`/"unavailable"; log the cause.
- No layers without two implementations; no source file over 1,500 lines (TypeScript and canonical `supabase/schemas/` files; migrations are exempt because they carry full function bodies, one per PR).
- Every behaviour change is walked through in the running app on a local database lane before
  merge, on a lane you hold (reset only that lane). Visible changes include
  screenshots in the pull request.

## Guardrails

`pnpm guard` has two tiers, blocking and warning. For the rules see `tooling/guard/config.ts` (each
rule has an owner and a review-by date). Any blocking finding fails the run (there is no baseline).
Unused code is `pnpm knip`'s job, not the guard's.

Use `// guard-allow: <rule> <reason>` on the offending line or the line directly above it. SQL supports `-- guard-allow: <rule> <reason>`, and block comments support `/* guard-allow: <rule> <reason> */`. The rule must be a real guard rule and the reason must contain at least 10 characters. Each directive covers one occurrence; the guard counts used exceptions per rule. An exception is appropriate only when the finding is intentional and a direct fix is not suitable; the reviewer must agree with the stated reason. Unmatched directives warn, while an unknown rule or short reason blocks the run.

Guards must stay current, or they rot into noise:

- A pull request that changes a feature a guard rule covers updates or removes that rule (and its allowances) in the same pull request.
- Every rule in `tooling/guard/config.ts` has an owner and a review-by date; the guard prints a notice once it passes, and the lead then keeps, changes or removes the rule.
