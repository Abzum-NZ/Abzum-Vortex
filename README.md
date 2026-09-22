# Abzum Vortex

Vortex builds applications from definitions: modules, records, fields, relationships, pages, permissions, actions and themes. Generic engines and the existing Next.js application render and execute those definitions.

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

## Development workflow

The GPT 5.6 Sol orchestrator selects the lowest unfinished pickup in the current roadmap phase, confirms a bounded scope and assigns the cheapest capable implementer. A separate Opus 5 or Sol reviewer fixes findings itself, re-reviews, integrates the reviewed change through permitted repository operations, updates/closes the assigned issue and reports. The orchestrator reconciles the board/dependencies, releases the agent, cleans the completed worktree and takes the next ordered task.

No tests, database review/execution, hosted verification, proof receipts, Kestra orchestration or Testing/Production deployment is part of this development workflow. Existing tooling and archived runbooks do not introduce extra gates. Product correctness, access control and isolation remain required.

## Repository

| Path | Responsibility |
| --- | --- |
| apps/web | Existing Next.js UI and server entry points |
| contracts | Current definition and operation schemas |
| runtime | Owning engines with public interfaces |
| db, supabase | Database boundary, schema and migration source |
| ui, studio | UI components and later designer |
| modules | Ordinary shipped application/module definitions |
| docs | Specification, roadmap, fleet policy and historical evidence |
| testing, tooling, workflows | Existing fixtures, developer utilities and operational assets; not fleet completion requirements |

Use Node and pnpm versions pinned in package.json. Dependency versions live in workspace manifests/catalogue and lockfile. Normal local development starts with pnpm install --frozen-lockfile and pnpm dev when needed for implementation. This does not authorize database or hosted operations, and running a server is not a completion gate.

Packages use each other's public interfaces. Business application names and special cases belong in definitions, not generic engines. Preserve current permissions, transactions, revisions, explicit publication/installation and safe errors. Keep credentials out of browser bundles, commits, prompts and logs.
