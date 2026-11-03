# Vortex: working instructions

Vortex builds business applications from versioned definitions (modules, record types, fields,
relationships, pages, permissions, actions, flows, connections, themes). Generic engines and a
Next.js application render and execute those definitions for many organisations, with access
enforced by the platform and the database.

## One way only

Vortex is a fresh project with no backward compatibility. Every concern has exactly one format, one contract and one code path. Replace contracts and formats in place, convert shipped definitions in the same change, and rebuild existing data with a forward migration. Do not add converters, upgraders, dual readers, compatibility branches, legacy mirrors, or a second way of doing something that already has one. When you find two ways, remove one.

## Layout

| Path                   | Contents                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `apps/web`             | Next.js application and local development setup                                |
| `packages/platform`    | Domain schemas, server operations and database access                          |
| `packages/ui`          | Shared components and the designer                                             |
| `packages/definitions` | Shipped application and module definitions                                     |
| `supabase`             | Config, `schemas/` (canonical function files), `migrations/`, seed             |
| `workflows/kestra`     | Operational flows and scripts                                                  |
| `tooling`              | Development tools (guard, local database lanes, off-theme detector, tsconfigs) |
| `docs`                 | `specification/` (product), `architecture/` (binding architecture and designs) |

## Run locally

```
pnpm install
pnpm db:start      # local Supabase
pnpm db:reset      # apply migrations and seed (destructive: a fresh clone only)
pnpm setup:local   # provision the development organisation and install modules
pnpm dev           # the main local stack only; on a lane start the server with lane.mjs serve (below)
```

Environment variables are described in `README.md` and `apps/web/.env.example`.
`pnpm verify` runs format check, lint, typecheck and build.
`pnpm guard` blocks new architecture violations and reports the remaining checks as warnings.
Run `pnpm knip` (unused code) before declaring work ready.

## Local database lanes

Local development runs on lanes: lighter Local Supabase stacks (no Studio, logs or edge runtime)
under `VORTEX_LANES_ROOT` (default `A:/Apps/vortex-lanes`), each with every port of
`supabase/config.toml` shifted per lane. The lane numbers, ports and guest-server windows live once,
in `tooling/supabase/lane.mjs`. `node tooling/supabase/lane.mjs status` lists every lane with its
ports, holder, recorded servers, the free RAM and which lanes are blocked on this host; `free` offers
an available lane. Use only the lane you were given.

Lanes are disposable. Each lane has one holder. Reset only a lane you hold; never reset another
agent's lane. When `main` moves, forward migrate the lane or reset it. To set up without a reset,
run `pnpm demo:owner` and then `pnpm setup:local -- --local-development --first-owner-identity-id <uuid>`
with the printed identity.

```
node tooling/supabase/lane.mjs init <n>     # once: generate the lane config
node tooling/supabase/lane.mjs start <n> .  # claim and start the database; stop <n> . releases it
node tooling/supabase/lane.mjs env <n>      # lines for apps/web/.env.development.local
node tooling/supabase/lane.mjs sync <n> .   # mirror migrations and seed and update the lane's auth origin, no reset
node node_modules/supabase/dist/supabase.js migration up --include-all --local --workdir <lane directory>  # forward migrate
node tooling/supabase/lane.mjs reset <n> .  # destructive: mirror migrations and seed, then reset (your lane only)
node tooling/supabase/lane.mjs serve <n> .             # the holder's dev server, on the lane's own port
node tooling/supabase/lane.mjs serve <n> . --port <p>  # a guest's dev server on lane n's database
node tooling/supabase/lane.mjs unserve <n> .           # end the servers this tool recorded for this worktree
VORTEX_SUPABASE_WORKDIR=<lane directory> pnpm demo:setup  # provision without resetting
```

`env` prints the lane's connection values, including `VORTEX_RUNTIME_DATABASE_URL`,
`VORTEX_DEV_SERVICE_ROLE_KEY`, `VORTEX_QUERY_CONTINUATION_KEY` and `VORTEX_SESSION_COOKIE_NAME`; put
them in the worktree's ignored `apps/web/.env.development.local`, never in a tracked file or a log.
With `VORTEX_SUPABASE_WORKDIR` set, the demo and development setup scripts pass `--workdir` to every
Supabase CLI call.

**RAM.** Every start (lane stack, dev server, build, walk, agent) needs at least 2 GB free. `start`
and `serve` print the reading and refuse below it.

**Dev servers on a lane.** On a lane, start every dev server with `lane.mjs serve <n> .`, never
`pnpm dev` or `next dev`: a server started any other way is unrecorded, so `stop` cannot refuse for
it and nothing can end it safely. The holder serves the lane's own port; any other worktree is a
guest on the `--port` it names, inside the guest window `lane.mjs` defines. A guest is refused when
its branch changes `supabase/migrations` or `supabase/schemas` relative to `origin/main`, when the
lane's mirrored migrations differ from this branch's (a branch with a migration needs its own lane),
or when the port is taken or excluded. A guest's server also delivers the lane's queued events, so a
branch that changes event or workflow delivery takes its own lane. `stop` and `reset` refuse while
guests run. `unserve` ends only the process trees `serve` recorded, by process ID, never by image
name, and never the supervised demo server on 3630.

**Lane 3** is the shared demo lane. It cannot be reset, and only the primary checkout runs `start`,
`stop` and `sync` on it; the primary checkout serves on no other lane.

## Rules

The [target architecture](docs/architecture/target-architecture.md) is binding: read it before
changing code. It holds the product rules (one renderer, no business
application names in engines, no absent-setting behaviour, one contract version, loud failures, no
process artefacts), the layout and dependency direction, the database roles, the record write path
and the error rules. In addition:

- English only, in code, comments, documents and commit messages.
- Work on a branch and open a pull request to `main`. Never push to `main`.
- No automated tests are written or run (owner decision). Do not add test files, test runners or test dependencies.
- The UI is definition-driven: frame, navigation, layout, pages and theme come from definitions.
  Engines only render. Do not hard-code a shell, navigation or theme in an engine.
- Migrations: add a new numbered file under `supabase/migrations`; never edit an applied one.
  When a database function changes, its canonical file in `supabase/schemas` and the migration
  must hold the identical definition.
- Tenant and organisation isolation, current permission checks, atomic writes, revision checks and
  safe errors are product requirements. Preserve them in every change.
- Keep secrets out of files, prompts and logs.
- No source file over 1,500 lines (TypeScript and canonical `supabase/schemas/` files; migrations are exempt because they carry full function bodies, one per PR).
- **shadcn only:** Studio uses shadcn/ui components only, and they take all colour, radius, font,
  spacing and state from the theme (Vortex, organisation or application level) through the `cn-`
  style classes and tokens. Every interactive or structural element in `packages/ui/src/studio`,
  `apps/web/app/studio` and, where Studio uses it, `packages/ui/src/navigation` comes from
  `packages/ui/src/components`: no raw button/input/select/textarea/dialog/details/fieldset/label, no
  local component duplicating a name in `components/`, no class strings recreating a shadcn variant,
  no fixed colours, radii or fonts in Studio code, and no direct imports of a primitive library
  (`@base-ui`, `@radix-ui`, `cmdk`) outside `components/`. Empty states use `Empty`, loading uses
  `Spinner`, and messages use `Alert`. A missing shadcn component is added to `components/` with its
  `cn-` styles first. Exceptions (skip link, hidden or file inputs, the navigation tree) carry a
  comment `// shadcn-only: <reason>` on the line or the line above.
- Reads serve the visible page first. Studio preview may continue an idle background fill after the
  visible page's requested data is served; never prefetch speculatively before it.
- Every behaviour change is walked through in the running app on a local database lane you hold
  before merge. Visible changes include screenshots in the pull request.

## Guardrails

`pnpm guard` has two tiers, blocking and warning. For the rules see `tooling/guard/config.ts` (each
rule has an owner and a review-by date). Any blocking finding fails the run (there is no baseline).
Unused code is `pnpm knip`'s job, not the guard's.

Use `// guard-allow: <rule> <reason>` on the offending line or the line directly above it. SQL supports `-- guard-allow: <rule> <reason>`, and block comments support `/* guard-allow: <rule> <reason> */`. The rule must be a real guard rule and the reason must contain at least 10 characters. Each directive covers one occurrence; the guard counts used exceptions per rule. An exception is appropriate only when the finding is intentional and a direct fix is not suitable; the reviewer must agree with the stated reason. Unmatched directives warn, while an unknown rule or short reason blocks the run.

A pull request that changes a feature a guard rule covers updates or removes that rule (and its allowances) in the same pull request. The guard prints a notice once a rule passes its review-by date; the lead then keeps, changes or removes it.
