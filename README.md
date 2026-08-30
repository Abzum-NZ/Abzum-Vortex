# Abzum Vortex

A multi-tenant, metadata-driven business application builder. Organisations assemble applications
out of headless modules — record types, fields, relationships, permissions, actions, rules and
events — and the platform renders every page from definitions stored as rows.

## The documents that govern this repository

| Document | Where |
|---|---|
| Platform Specification (33 chapters, 5 appendices) | https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4 |
| Build Plan (prerequisites, dependency map, ten phases) | https://claude.ai/code/artifact/58852ead-2acc-4ca6-a693-6cb03705bcef |
| Project board | https://github.com/orgs/Abzum-NZ/projects/2 |

The specification is authoritative. A change of behaviour is a change to the specification first.

## What runs

Three services and no others (Specification, Chapter 24):

| Part | What it is |
|---|---|
| The web application | One Next.js project on Vercel. Serves every tenant, application and page. |
| The database | One Supabase project. PostgreSQL, sign-in, file storage and live updates. |
| The workflow engine | Self-hosted Kestra on a Coolify-managed virtual server, with its own state database. |

## Repository layout

One repository, one deployable application (Specification, section 24.3). Packages depend one way
only, and a deep import fails the build.

```
web/        The Next.js application. The only thing deployed.
contracts/  The shapes of modules, pages, records and events. Depends on nothing.
db/         Database clients, the server's data layer, the access rules, generated types.
runtime/    The module registry, records and fields, rules, pages, search.
ui/         The shadcn/ui base and the block library.
studio/     The designers.
modules/    The module definitions Abzum ships.
testing/    Fixtures, the permission matrix, the database tests.
migrations/ Ordered database migrations and their tests.
workflows/  Workflow definitions deployed to the workflow engine.
```

## How a change reaches production

```
feature branch ──PR──▶ testing ──PR──▶ main
     │                    │              │
  Development          Testing       Production
  (preview per PR)  (staging alias)  (live domain)
```

- Vercel builds, deploys, and is the only gate. Its Git integration builds every pull request and
  every branch. Branch protection on `testing` and `main` requires one check before a merge:
  `Vercel`.
- The build runs the checks before it builds: types, linting, the package boundary rules and unit
  tests. A failing check fails the build, so the change cannot merge and has no preview until it is
  fixed. That cost is accepted deliberately, in exchange for one system rather than two.
- **There is no GitHub Actions.** Nothing here runs on it and no credential is stored there. A
  release is cut with `gh release create --generate-notes`, which needs no workflow.
- The database access-rule tests create roles and switch row-level security on and off, which needs a
  real Postgres session that a Vercel build cannot hold. Kestra runs them, against the second Supabase
  project — the testing one. Kestra also applies migrations: automatically to testing, and to
  production only with approval.
- Every schema change ships as a migration file with its permission tests in the same change.
- `testing` is the integration branch. Vercel serves it at the staging alias.
- `main` is production. It takes pull requests from `testing` only, and a release is tagged from it.
- Rolling back a build never reverses an applied migration.

## Secrets and connections

Doppler holds every secret. Nothing is typed into Vercel by hand.

| Doppler config | Vercel environment | Serves |
|---|---|---|
| `prd` | Production | `main` |
| `stg` | Preview | `testing` and every pull request preview |
| `dev` | Development | `vercel dev` on your own machine |

Change a value in Doppler and it reaches Vercel within seconds. A value changed in Vercel is
overwritten on the next sync and lost, so there is one place to change anything.

**Never add a variable in Vercel by hand.** Beyond the obvious drift, doing so can silently break the
sync — see below.

### The rule that will cost you an hour if you do not know it

Vercel lets a variable be marked **Sensitive**, meaning nobody can read it back afterwards, not even
you. Doppler writes its variables that way. Vercel also enforces that **one name is the same kind
everywhere**: a name cannot be Sensitive in Production and ordinary in Preview.

So if a hand-made, ordinary variable already exists under a name Doppler is about to own, Vercel
refuses to create Doppler's — and **says nothing**. Doppler's dashboard continues to report `In Sync`,
Vercel shows no error, and the variable simply never appears. This happened twice while the project
was being set up, to `DATABASE_URL` and to the three `KESTRA_API_*` values.

If a secret exists in Doppler with a value and has not appeared in Vercel: look for a hand-made copy
of that name on another environment, delete it, then re-sync from Doppler's **Config Syncs** tab. A
sync reporting `In Sync` is not evidence that anything was written.

### A password appears in one place only

`DATABASE_URL` does not contain the password. It references it:

```
postgresql://postgres.<project-ref>:${DATABASE_PASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
```

Doppler resolves the reference when it syncs, so Vercel receives a complete string. Rotating the
password means changing `DATABASE_PASSWORD` alone; the connection string rebuilds itself. Nobody has
to remember that a password is also embedded in a URL somewhere.

### Names the browser can see

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` carry the prefix because Next.js
exposes only prefixed variables to browser code, and the Supabase client used for signing in and for
live updates runs in the browser. Both values are public by design. Dropping the prefix does not make
them secret; it makes them unreadable to the code that needs them.

There is deliberately **no Supabase service-role key anywhere**. The application connects as the
application database account over Postgres, per Specification section 2.12. If one appears, it is a bug.

### Two ways into the database, on purpose

| Caller | Route | Port | Why |
|---|---|---|---|
| The web application | session pooler | 5432 | Vercel egresses over IPv4. The direct host is IPv6-only, and the transaction pooler needs the paid IPv4 add-on |
| Kestra, applying migrations and running the access-rule tests | direct connection | 5432 | Both need a real Postgres session: migrations take a session-level advisory lock, and the access-rule tests create roles and change row-level security. Kestra runs on our own server, where IPv6 is available |

Session mode behaves like a direct connection, so the client needs no special configuration. If the
IPv4 add-on is ever bought and the application moves to the transaction pooler on 6543, prepared
statements must be turned off in the client — transaction mode gives the next statement a different
physical connection.

The pooler allows **15 connections** on the current compute, and in session mode a caller holds one
for as long as it stays connected. Keep the client pool to one or two per instance; a library default
of ten exhausts the pool with two warm instances.

## Pinned versions

Each of these moves only as its own pull request, never as a side effect of another change. No caret
and no range on any of them.

| Dependency | Pin | Why this one |
|---|---|---|
| `next` | `16.3.3` | Newest stable 16.x. Every page renders through it. |
| `react`, `react-dom` | `19.2.8` | Next.js and Puck each constrain React. It is chosen rather than resolved. |
| `@puckeditor/core` | `0.23.0` | The page designer. |
| Node | `24` | Next.js 16 requires `>= 20.9.0`. 24 is current long-term support and what Vercel selects by default, so there is one less thing to keep in step. Pinned in three files — see below. |

**Node is pinned in three places, and it has to be.** Vercel does not read `.nvmrc`. It reads
`engines.node` in `package.json` first, then a `.node-version` file, then the project setting in the
Vercel dashboard. `.nvmrc` exists for local tooling only. Set one and miss the others and the machine
you develop on quietly runs a different Node from the one that builds production — which is exactly
what happened here: `.nvmrc` said 22 while Vercel built with 24, and nobody would have noticed until
something broke that only breaks on one of them.

| File | Read by |
|---|---|
| `.nvmrc` | `nvm` and local tooling. Vercel ignores it. |
| `.node-version` | Vercel, and most version managers. |
| `engines.node` in `package.json` | Vercel, above everything else. Added when the workspace root lands (#10). |

**Puck is `@puckeditor/core`, not `@measured/puck`.** The project renamed its package. The old name
is frozen at `0.20.2` from September 2025 and receives nothing, while the project itself released
`0.23.0` in August 2026 and is actively committed to. Reaching for the old name gets a package a year
stale that looks maintained because the project is.

Puck is still pre-1.0. Appendix D chose it knowing that, and the answer is the block registration
contract of Specification section 29.9: the platform depends on Puck through one registration layer,
so a breaking change upstream is absorbed in one place rather than across the block library.

## Addresses

| Environment | Address | Serves |
|---|---|---|
| Production | `https://vortex.abzum.com` | `main` |
| Testing | `https://vortex-testing.abzum.com` | `testing`, behind Vercel Authentication |
| Development | A preview address issued per pull request | that pull request's branch |

The tenant's short name is the first path segment (Specification, section 2.7):

```
https://vortex.abzum.com/{tenant}/{application}/{page}
```

Signing in happens at one address, outside any tenant. The Tenant Portal is an application like any
other and is installed in every tenant, so it is served under that tenant's own segment alongside
every other application.

The first path segment is therefore shared between tenant short names and the platform's own paths,
so `signin`, `auth`, `health` and `api` are reserved and refused as short names (Specification,
section 2.2). The reserved list is read from the same table the platform reads addresses from, and a
path added to the platform is added to that list in the same change.

Tenant subdomains, `{tenant}.abzum.com`, are not in the first release (Specification, Appendix D.2).
Adding them later needs a wildcard domain on the Vercel project, which is a paid feature, and the
address verification of section 2.7 — an address becomes usable only once verified, and an
unrecognised address is refused rather than falling back to a default. A blanket wildcard would
contradict that rule, so none is configured. The `*.abzum.com` record that exists in Cloudflare today
points elsewhere and is not part of this platform.

DNS is served by Cloudflare. Both platform records are `CNAME` to Vercel with the proxy disabled;
Vercel terminates TLS itself and a proxied record would break certificate issue.

## Working here

- The project board at https://github.com/orgs/Abzum-NZ/projects/2 is the single source of truth
  for what is being worked on. Every change belongs to an issue; the issue is updated when the
  work lands.
- Issues follow the ten phases of the Build Plan. An issue's "Blocked by" list is real: work on an
  issue only when everything it is blocked by is closed.
- Where an issue touches something a person sees, its acceptance criteria include a screenshot of
  the built functionality attached to the issue before it is closed.
