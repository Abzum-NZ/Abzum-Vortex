# Abzum Vortex

Vortex is a platform for building business applications from versioned definitions:
modules, record types, fields, relationships, pages, permissions, flows and connections.
It serves multiple organisations through one application, with access enforced by
the platform and database.

The project is under active development. The current priority is to prove complete
applications defined in files before building the visual App Designer. The
[roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) records delivery status;
a specification or contract does not mean the feature is implemented.

Development is carried out by an orchestrated fleet of autonomous coding agents
rather than a single continuous team: one orchestrator plans, dispatches, watches
and reports, and implementer agents deliver work in isolated worktrees.
[Agent coordination](docs/build-plan/agent-coordination.md) and [agent fleet
operations](docs/build-plan/agent-fleet.md) record how that work is planned,
verified and promoted.

## Start here

| Document | Purpose |
| --- | --- |
| [Platform specification](docs/specification/README.md) | Product behaviour and architecture |
| [Build plan](docs/build-plan/README.md) | Delivery phases, dependencies and acceptance |
| [Engine-first delivery](docs/build-plan/engine-first-application-delivery.md) | Path to a usable application before the designer |
| [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) | Current tasks, ownership and pickup order |
| [Agent coordination](docs/build-plan/agent-coordination.md) | Planning, implementation, review and reporting rules |
| [Agent fleet operations](docs/build-plan/agent-fleet.md) | Roster, escalation, queue selection, gates and promotion for the autonomous fleet |
| [Agent handover — 18 September 2026](docs/build-plan/agent-handover-2026-09-18.md) | Copyable continuation prompt and dated checkpoint |
| [Open decisions](docs/specification/appendices/decisions.md) | Unresolved product choices requiring the owner's input |

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js on Vercel | Web application and server entry points |
| Supabase | PostgreSQL, authentication, private files and database-backed platform services |
| Kestra on Coolify | Durable background execution and operational delivery jobs |

Core contracts describe the capabilities needed to define, validate, publish,
secure and execute arbitrary applications. Business applications, including
Abzum's own, use those same primitives. Application names and business-specific
rules belong in definitions and fixtures, not in generic engines.

Application workflow steps use protected Vortex operations. Kestra's operational
database credentials are separate from application workflow execution. See the
[runtime boundaries](docs/specification/17-runtime-storage-and-caching.md) and
[workflow specification](docs/specification/09-workflows-and-pipelines.md).

## Repository

| Path | Contents |
| --- | --- |
| `apps/web/` | The Next.js application and deployment root |
| `contracts/` | Shared definition and operation schemas |
| `runtime/` | Engine packages with explicit public interfaces |
| `db/` | Database connection and transaction boundary |
| `ui/`, `studio/` | Shared UI and designer packages |
| `modules/` | Shipped application and module definitions |
| `testing/` | Shared fixtures and cross-package verification |
| `supabase/` | Database configuration, migrations, seed and database tests |
| `workflows/kestra/` | Operational flows, scripts and delivery documentation |
| `tooling/` | Workspace checks and development tools |
| `docs/` | Specification, build plans, prototypes and evidence |

A Vortex module is an application definition; a workspace package is source code.
Packages import one another through their public interfaces. The workspace
[boundary checker](tooling/boundaries/check.mjs) enforces dependency and environment rules.

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json).
Dependency versions live in package manifests, the [workspace catalogue](pnpm-workspace.yaml)
and lockfile.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server binds to `127.0.0.1`. Authentication and protected data
operations also require the appropriate environment configuration and database;
installing packages alone does not configure them. Follow the
[local database guide](supabase/README.md) and
[environment and credential rules](docs/specification/18-delivery-and-testing.md).

Useful commands from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm verify` | Database-free formatting, lint, types, boundaries, tests, fixtures and build |
| `pnpm fixtures` | Validate the shipped application fixtures |
| `pnpm db:verify` | Full local database verification using the disposable harness; requires Docker |

Choose checks appropriate to the changed behaviour. For focused database checks
and cleanup, use the [database guide](supabase/README.md); do not reset shared environments.

## Delivery and contribution

- Work from a GitHub issue with clear scope, dependencies and acceptance criteria.
  Keep its description and roadmap status current.
- Use the existing engine boundaries and official framework conventions. Update
  the specification and build plan when agreed behaviour or sequencing changes.
- Keep changes focused. Preserve organisation isolation, current permission checks,
  atomic writes and revision checks without introducing unnecessary abstractions.
- Obtain independent review and pass required PR checks before merging. Distinguish
  source merged, preview built, and hosted behaviour verified in the evidence.
- Use [Testing](https://vortex-testing.abzum.com) for current hosted acceptance.
  Production deployment is deferred until the final project stage. A merge to
  `main` is not evidence of a production release or successful database delivery.
- Follow the [delivery specification](docs/specification/18-delivery-and-testing.md)
  and [Kestra runbook](workflows/kestra/README.md) for environment changes. The dated
  handover records the recent authorised source consolidation and its remaining
  Testing requirements.
- Manage secrets through the documented Doppler configuration. Keep credentials
  out of source, browser bundles, agent prompts and logs.
