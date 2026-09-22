# Abzum Vortex

Vortex builds business applications from versioned definitions: modules, record types, fields, relationships, pages, permissions, actions, flows, connections and themes. It serves multiple organisations through one application, with access enforced by the platform and the database. Generic engines and the existing Next.js application render and execute those definitions.

The project is under active development. The current priority is a usable definition-led application before the visual App Designer. A specification or contract does not mean the feature is implemented; the [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) records delivery status.

Development is carried out by an orchestrated fleet of autonomous coding agents rather than a continuous team: one orchestrator plans, dispatches, reconciles and reports, implementers deliver bounded work in isolated worktrees, and independent reviewers fix their own findings and integrate the reviewed change.

## Start here

| Document | Purpose |
| --- | --- |
| [Agent instructions](AGENTS.md) | Entry point for every provider |
| [Agent coordination](docs/build-plan/agent-coordination.md) | Current roles, development acceptance and ownership |
| [Fleet operations](docs/build-plan/agent-fleet.md) | Strict pickup, bounded assignment, model routing, board updates and recovery |
| [Orchestration diagram](docs/build-plan/fleet-orchestration.html) | Implementation, reviewer fixes, closure and next-task handoff |
| [Roadmap](docs/build-plan/README.md) | Phase order and Phase 6 visible-application objective |
| [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) | Current issues, Pickup Order and status |
| [Platform specification](docs/specification/README.md) | Product functionality and architecture |
| [Definition-led application delivery](docs/build-plan/engine-first-application-delivery.md) | Path to a usable application before the designer |
| [Architecture review — 21 September 2026](docs/build-plan/architecture-review-2026-09-21.md) | Main-branch findings and revised implementation order |
| [Open decisions](docs/specification/appendices/decisions.md) | Unresolved product choices requiring the owner's input |

## Development workflow

The GPT 5.6 Sol orchestrator selects the lowest unfinished pickup in the earliest incomplete roadmap phase, confirms a bounded scope and assigns the cheapest capable implementer. A separate Opus 5 or GPT 5.6 Sol reviewer fixes findings itself, re-reviews, integrates the reviewed change through permitted repository operations, updates/closes the assigned issue and reports. The orchestrator reconciles the board/dependencies, releases the agent, cleans the completed worktree and takes the next ordered task.

No tests, database review/execution, hosted verification, proof receipts, Kestra orchestration or Testing/Production deployment is part of this development workflow. Existing tooling and archived runbooks do not introduce extra gates. Product correctness, access control, isolation, transaction integrity and safe errors remain required functionality.

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js on Vercel | Web application and server entry points |
| Supabase | PostgreSQL, authentication, private files and database-backed platform services |
| Kestra on Coolify | Durable background execution and operational delivery jobs as product functionality |

Core contracts describe the capabilities needed to define, validate, publish, secure and execute arbitrary applications. Business applications, including Abzum's own, use those same primitives. Application names and business-specific rules belong in definitions and fixtures, not in generic engines.

Application workflow steps use protected Vortex operations. Kestra's operational database credentials are separate from application workflow execution. See the [runtime boundaries](docs/specification/17-runtime-storage-and-caching.md) and [workflow specification](docs/specification/09-workflows-and-pipelines.md). Kestra is product capability; it is not part of fleet management or development acceptance.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Existing Next.js UI, server entry points and deployment root |
| `contracts/` | Current definition and operation schemas |
| `runtime/` | Owning engines with explicit public interfaces |
| `db/` | Database connection and transaction boundary |
| `ui/`, `studio/` | Shared UI components and the later designer |
| `modules/` | Ordinary shipped application and module definitions |
| `supabase/` | Database configuration, schema, migrations and seed |
| `testing/` | Shared fixtures and existing cross-package utilities |
| `workflows/kestra/` | Operational flows, scripts and delivery documentation |
| `tooling/` | Workspace checks and development tools |
| `docs/` | Specification, roadmap, fleet policy and historical evidence |

A Vortex module is an application definition; a workspace package is source code. Packages use each other's public interfaces and nothing depends upward; the workspace [boundary checker](tooling/boundaries/check.mjs) records those dependency and environment rules.

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json). Dependency versions live in package manifests, the [workspace catalogue](pnpm-workspace.yaml) and the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server binds to `127.0.0.1`. Authentication and protected data operations also need the appropriate environment configuration and database; installing packages alone does not configure them. Starting a server is not a completion gate, and this does not authorize database or hosted operations.

Existing developer utilities (`pnpm verify`, `pnpm fixtures`, `pnpm db:verify`) remain in the workspace for local use. They are not fleet completion requirements, and the current development workflow does not run them or treat their output as acceptance.

## Delivery and contribution

- Work from a GitHub issue with clear scope, dependencies and functional acceptance. Keep its description and roadmap status current.
- Use the existing engine boundaries and official framework conventions. Update the specification and build plan when agreed behaviour or sequencing changes.
- Keep changes focused. Preserve organisation isolation, current permission checks, atomic writes, revision checks and safe errors without introducing unnecessary abstractions.
- Use issue branches from `origin/main`, obtain an independent code review, and merge the reviewed implementation into `main`. Implementation plus that review is the completion criterion.
- Hosted delivery and Production are outside this development pass.
- Follow [agent coordination](docs/build-plan/agent-coordination.md) and the [delivery specification](docs/specification/18-delivery-and-testing.md) for the current development policy. Historical handovers do not add requirements.
- Manage secrets through the documented Doppler configuration. Keep credentials out of source, browser bundles, agent prompts and logs.
