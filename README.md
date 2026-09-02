# Abzum Vortex

Vortex is a business application builder. One organisation assembles its applications from parts the
platform already understands — record types, fields, relationships, permissions, actions, rules and
events — and the platform draws every page from those definitions, which it stores as rows in a
database rather than as code.

Many organisations share one deployment. Rules inside the database keep each organisation's data
apart from every other organisation's.

## The documents that govern this repository

| Document | Where |
|---|---|
| Platform Specification 2.0 | [docs/specification/README.md](docs/specification/README.md) |
| Build Plan 2.0 | [docs/build-plan/README.md](docs/build-plan/README.md) |
| Open business decisions | [docs/specification/appendices/decisions.md](docs/specification/appendices/decisions.md) |
| Coverage of the earlier specification and plan | [docs/specification/appendices/traceability.md](docs/specification/appendices/traceability.md) |
| Specification-to-GitHub task coverage | [docs/specification/appendices/github-delivery-map.md](docs/specification/appendices/github-delivery-map.md) |
| Project board | [Vortex GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2) |
| Earlier Platform Specification (superseded source) | [33 chapters and 5 appendices](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4) |
| Earlier Build Plan (superseded source) | [Prerequisites, dependency map and ten phases](https://claude.ai/code/artifact/58852ead-2acc-4ca6-a693-6cb03705bcef) |

Platform Specification 2.0 and Build Plan 2.0 are authoritative. Change the specification before
changing behaviour, never after.

## What runs

Three services, and nothing else (Specification, Chapter 24).

| Service | What it is |
|---|---|
| The web application | One Next.js project on Vercel. It serves every organisation, application and page. |
| The database | One Supabase project. It provides PostgreSQL, sign-in, private file storage, content-free live invalidation and a durable queue. |
| Kestra | A self-hosted Kestra server on a Coolify-managed machine, with its own database. It runs background work. |

**Kestra is not one of the sixteen engines, and nobody using Vortex ever sees it.** Specification
section 15.3 draws the line. Vortex owns the designer where someone draws a workflow, owns the
definitions, and owns every touch of a business record. A business workflow step calls back into
Vortex, so the same permission checks apply as when a person clicks a button; Kestra never receives a
broad runtime credential that lets a workflow read organisation data directly. Separate operational
flows use narrowly scoped database roles for migrations, access-rule tests, and encrypted backups.
Those roles cannot be used by customer-authored workflows and do not replace Vortex's service and
permission boundaries.

The **Workflow engine** is a different thing. It is one of the sixteen engines in Specification
section 25.1, and it is our code — the code that drives Kestra. Where this file says *Kestra* it means
the server. Where it says *the Workflow engine* it means our code. They are never the same thing.

## Repository layout

One repository, one deployable application (Specification, section 24.3).

### The workspace

The root `package.json` declares the workspace. It also pins the Node version and holds the scripts
every package shares.

```text
package.json          The workspace root. It declares the members below.
apps/web/             The Next.js application. The only thing Vercel deploys.
contracts/            The shapes of modules, pages, records and events. Depends on nothing.
db/                   Database clients, the server data layer, the access rules, generated types.
runtime/              Sixteen packages, one per engine. See below.
ui/                   The shadcn/ui base and the block library.
studio/               The designers — the screens where someone builds an application.
modules/              The module definitions Abzum ships.
testing/              Fixtures, the permission matrix, the database tests.
migrations/           Not a package. Ordered database migrations and their tests.
workflows/            Not a package. Kestra flow definitions.
```

The workspace members are:

```json
"workspaces": ["apps/*", "contracts", "db", "runtime/*", "ui", "studio", "modules", "testing"]
```

`runtime/*` is the line that matters. Section 24.3 states that the runtime is one package per engine
rather than one package holding all sixteen. So `runtime/` is a directory that contains packages, and
is never a package itself. The sixteen, in the order section 25.1 lists them:

```text
runtime/definition   runtime/identity   runtime/access      runtime/module
runtime/record       runtime/query      runtime/rule        runtime/event
runtime/workflow     runtime/app        runtime/page        runtime/theme
runtime/search       runtime/file       runtime/connection  runtime/interface
```

Name every package after its public responsibility, prefixed with `@vortex/`. So `contracts/`
becomes `@vortex/contracts`, and `runtime/record` becomes `@vortex/record`. The `runtime/` directory
groups engine packages in the repository; it is not part of their public import names.

`migrations/` and `workflows/` sit outside the workspace. Nothing imports either one. Kestra applies
the migrations. The application never does.

### What every package declares

Dependencies run one way only. No package depends on one above it, and no package reaches inside
another package's files.

Every package declares three things. The build works out the allowed dependency graph from those
declarations, rather than from a list someone keeps by hand.

| Declaration | What it decides |
|---|---|
| What the package makes public | The build refuses any import that reaches past it |
| Where the package sits in the engine order of section 25.3 | Which packages it may depend on |
| Whether the package may run in a browser | Whether server-only code may enter it |

Database credentials and secrets carry a server-only marker. The build refuses to let them enter a
package that runs in a browser.

### The word "module" means two unrelated things

This catches people out, so read it once.

| Sense | Where it lives | What it is |
|---|---|---|
| A **Vortex module** | Rows in the database. Abzum authors its own under `modules/` | A definition — record types, fields, relationships, permissions, rules, events. An organisation assembles its application from these. Specification chapter 27 |
| A **package** | A directory in this repository | Code that ships. The workspace members listed above |

So `studio/` is a package and not a Vortex module. It is code. Nothing stores it as rows, and no
application carries it.

The word *workflow* splits the same way. A workflow **inside an application** is a definition, and the
application carries it and publishes it in the same revision (Specification section 26.2). The
`workflows/` directory holds something unrelated: Kestra flows that operate the platform itself, such
as applying migrations. One is product. The other is plumbing.

## How a change reaches production

This flow is the approved delivery policy. Pull requests do not start a database; database migrations
and access tests run after merge to `testing` and must pass before that revision can be promoted to
`main`. See [Delivery environments, database changes and testing](docs/specification/18-delivery-and-testing.md).

```text
feature branch ──PR──▶ testing ──PR──▶ main
     │                    │              │
  Development          Testing       Production
  (preview per PR)  (staging alias)  (live domain)
```

- Vercel builds, deploys, and gates. Its Git integration builds every pull request and every branch.
  Branch protection on `testing` and `main` requires one check before a merge: `Vercel`.
- The build runs formatting, types, linting, package-boundary, unit, contract and build checks without
  a database. A failing check fails the build, so the change cannot merge and gets no preview until
  someone fixes it. We accept that cost deliberately, to run one system rather than two.
- **Nothing runs on GitHub Actions, and nothing stores a credential there.** Cut a release with
  `gh release create --generate-notes`, which needs no workflow.
- The access-rule tests create roles and switch row-level security on and off. That needs a real
  PostgreSQL session, which a Vercel build cannot hold, so Kestra runs them against the second
  Supabase project — the testing one. Kestra also applies migrations: to testing without asking, and
  to production only after someone approves.
- Every schema change ships as a migration file, and carries its permission tests in the same change.
- `testing` is the integration branch. Vercel serves it at the staging address.
- `main` is production. It accepts pull requests from `testing` only, and releases are tagged from it.
- Administrator bypass remains available only for break-glass recovery. Every use records an incident, exact commit, operator, time, reason normal review was impossible, and an immediate follow-up review; it cannot make a failed required check acceptable.
- Rolling back a build never reverses a migration that has already run.

## Secrets and connections

Doppler holds every secret. Nobody types one into Vercel by hand.

| Doppler config | Vercel environment | Serves |
|---|---|---|
| `prd` | Production | `main` |
| `stg` | Preview | `testing` and every pull request preview |
| `dev` | Development | `vercel dev` on your own machine |

Change a value in Doppler and it reaches Vercel within seconds. Change one in Vercel and the next
sync overwrites it, so there is exactly one place to change anything.

### Vercel can refuse a secret and still report success

Vercel lets a variable carry a **Sensitive** marker. Nobody can read the value back afterwards, not
even you. Doppler writes its variables that way. Vercel also insists that **one name carries the same
marker everywhere**: a name cannot be Sensitive in Production and ordinary in Preview.

So when an ordinary variable already exists under a name Doppler is about to write, Vercel refuses
Doppler's — and reports nothing. Doppler keeps showing `In Sync`, Vercel shows no error, and the value
never arrives. This happened twice while we set the project up: to `DATABASE_URL`, and to the three
`KESTRA_API_*` values. Each cost an hour, because a green status looked like proof.

**When a secret has a value in Doppler but has not appeared in Vercel:** find the hand-made copy of
that name on another environment, delete it, then re-sync from Doppler's **Config Syncs** tab. A sync
that reports `In Sync` proves nothing about whether it wrote anything.

That is why nobody adds a variable in Vercel by hand.

### A password lives in exactly one place

`DATABASE_URL` does not contain the password. It points at it:

```text
postgresql://postgres.<project-ref>:${DATABASE_PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
```

Doppler resolves that reference as it syncs, so Vercel receives a complete string. To rotate the
password, change `DATABASE_PASSWORD` and nothing else. The connection string rebuilds itself, and
nobody has to remember that a password also sits inside a URL somewhere.

### Names the browser can read

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` carry that prefix because
Next.js hands only prefixed variables to browser code, and the Supabase client that signs people in
and delivers live updates runs in the browser. Both values are public by design. Removing the prefix
would not make them secret. It would only hide them from the code that needs them.

**No Supabase service-role key exists anywhere, deliberately.** The application connects as the
application database account over PostgreSQL, which Specification section 2.12 requires. If a
service-role key appears, treat it as a bug.

### Two ways into the database, on purpose

| Caller | Route | Port | Why |
|---|---|---|---|
| The web application | Session pooler | 5432 | Vercel sends traffic over IPv4. The direct host answers only on IPv6, and the transaction pooler needs the paid IPv4 add-on |
| Kestra operational flows | Direct connection | 5432 | Migrations and access-rule tests need a real PostgreSQL session; encrypted logical backup needs a dedicated read-only backup role. Each job uses its own narrow role. Kestra runs on our own machine, which has IPv6. Business workflow steps do not use these connections. |

Session mode behaves like a direct connection, so the client needs no special configuration.

If we ever buy the IPv4 add-on and move the application to the transaction pooler on port 6543, turn
prepared statements off in the client first. Transaction mode hands the next statement a different
physical connection, so nothing the server remembered survives.

The pooler allows **15 connections** on the current compute size, and in session mode one caller holds
one connection for as long as it stays connected. Keep the client pool to one or two per instance. A
library default of ten exhausts the pool with two warm instances.

## Pinned versions

Each of these moves only in its own pull request, never as a side effect of another change. Use no
caret and no range on any of them.

| Dependency | Pin | Why this one |
|---|---|---|
| `next` | `16.3.3` | Newest stable 16.x. Every page renders through it. |
| `react`, `react-dom` | `19.2.8` | Next.js and Puck each constrain React. We choose the version rather than let a resolver pick it. |
| `@puckeditor/core` | `0.23.0` | The page designer. |
| Node | `24` | Next.js 16 requires `>= 20.9.0`. 24 is current long-term support and the version Vercel selects by default, so there is one less value to keep in step. |

**Pin Node in three files, and miss none of them.** Vercel does not read `.nvmrc`. It reads
`engines.node` in `package.json` first, then a `.node-version` file, then the setting in the Vercel
dashboard. `.nvmrc` serves local tooling only.

Set one and miss the others, and your machine quietly runs a different Node from the one that builds
production. That already happened here: `.nvmrc` said 22 while Vercel built with 24, and nobody would
have noticed until something broke on one and not the other.

| File | Read by |
|---|---|
| `.nvmrc` | `nvm` and local tooling. Vercel ignores it. |
| `.node-version` | Vercel, and most version managers. |
| `engines.node` in `package.json` | Vercel, ahead of everything else. Added when the workspace root lands (#10). |

**Puck is `@puckeditor/core`, not `@measured/puck`.** The project renamed its package. The old name
froze at `0.20.2` in September 2025 and receives nothing, while the project released `0.23.0` in
August 2026 and commits to it actively. Reaching for the old name gets you a package a year stale that
looks maintained, because the project behind it is.

Puck has not reached 1.0. Appendix D chose it knowing that. The answer is the block registration
contract of Specification section 29.9: the platform touches Puck through one registration layer, so a
breaking change upstream lands in one place rather than across the whole block library.

## Addresses

| Environment | Address | Serves |
|---|---|---|
| Production | `https://vortex.abzum.com` | `main` |
| Testing | `https://vortex-testing.abzum.com` | `testing`, behind Vercel Authentication |
| Development | A preview address issued per pull request | that pull request's branch |

The organisation's short name is the first path segment (Specification, section 2.7):

```text
https://vortex.abzum.com/{organisation}/{application}/{page}
```

People sign in at one address, outside any organisation. The Tenant Portal is an application like any
other, and every organisation has it installed, so it appears under that organisation's own segment
beside every other application.

The first path segment therefore holds both organisation short names and the platform's own paths. So
the platform reserves `signin`, `auth`, `health` and `api`, and refuses them as short names
(Specification, section 2.2). The platform reads that reserved list from the same table it reads
addresses from. Add a path to the platform, and add it to that list in the same change.

Subdomains per organisation, `{organisation}.abzum.com`, are not in the first release (Specification,
Appendix D.2). Adding them later needs a wildcard domain on the Vercel project, which is a paid
feature. It also needs the address verification of section 2.7: an address works only once someone
verifies it, and the platform refuses an address it does not recognise rather than falling back to a
default. A blanket wildcard would contradict that rule, so we configure none. The `*.abzum.com` record
that exists in Cloudflare today points elsewhere and has nothing to do with this platform.

Cloudflare serves DNS. Both platform records are `CNAME` records pointing at Vercel with the proxy
switched off. Vercel terminates TLS itself, and a proxied record would break certificate issue.

## Working here

- The [GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2) records what anyone is working on.
  Every change belongs to an issue. Update the issue when the work lands.
- Issues follow the phases in the [revised Build Plan](docs/build-plan/README.md). Use GitHub's native
  dependency links: start an issue only once everything blocking it is closed.
- Where an issue touches something a person sees, attach a screenshot of the built functionality to
  the issue before closing it.
- **Everything fails loudly.** Nothing falls back to a default, carries on with a wrong value, or
  continues when it cannot establish what it needs. Many organisations share one database here, so a
  silent wrong answer is worse than an error: the damage is done before anyone knows there is a
  problem.
