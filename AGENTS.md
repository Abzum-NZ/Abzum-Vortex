# Vortex: working instructions

Vortex builds business applications from versioned definitions (modules, record types, fields,
relationships, pages, permissions, actions, flows, connections, themes). Generic engines and a
Next.js application render and execute those definitions for many organisations, with access
enforced by the platform and the database.

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
pnpm db:reset      # apply migrations and seed
pnpm setup:local   # provision the development organisation and install modules
pnpm dev
```

Environment variables are described in `README.md` and `apps/web/.env.example`.
`pnpm verify` runs format check, lint, typecheck and build.
`pnpm guard` blocks new architecture violations and reports the remaining checks as warnings.

## Rules

The [target architecture](docs/build-plan/target-architecture.md) is binding: read it before changing code. In short:

- English only, in code, comments, documents and commit messages.
- Work on a branch and open a pull request to `main`. Never push to `main`.
- No tests. Do not add test files, test runners or test dependencies.
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
- No absent-setting behaviour: defaults live in definitions (Puck `defaultProps`), not in renderers.
- One current version of every contract: no `V2`/`V3` copies.
- One record write path (`apply_record_changes`), one activity append, one idempotency table.
- No process artefacts in product code: no review receipts, fingerprints, continuity or evidence.
- Fail loudly on platform-produced data: never turn a parse failure or database error into a silent
  `null`/"unavailable"; log the cause.
- No layers without two implementations; no source file over 1,500 lines.
- Every behaviour change is walked through in the running app on a freshly reset local database
  before merge.

## Guardrails

`pnpm guard` has two tiers. Blocking rules protect business-name boundaries, package layering, migration parity and function UUIDs, and versioned names. A new blocking finding must be fixed or covered by a reviewed, occurrence-specific exception. File size, unused files/exports/dependencies, process artefacts and silent-parse findings are warnings; they are printed in CI and do not fail the run. Warnings are not stored in the baseline. The baseline applies only to blocking findings; stale entries are reported as warnings. Blocking baseline identities follow Git rename history, and `pnpm guard --update-baseline` persists a moved path.

Use `// guard-allow: <rule> <reason>` on the offending line or the line directly above it. SQL supports `-- guard-allow: <rule> <reason>`, and block comments support `/* guard-allow: <rule> <reason> */`. The rule must be a real guard rule and the reason must contain at least 10 characters. Each directive covers one occurrence, and the guard lists every used exception. An exception is appropriate only when the finding is intentional and a direct fix is not suitable; the reviewer must agree with the stated reason. Unmatched directives warn, while an unknown rule or short reason blocks the run.

Each rule's owner and review-by date are recorded in `tooling/guard/config.ts`. The guard prints a notice after a review date passes; the notice does not fail the run.
