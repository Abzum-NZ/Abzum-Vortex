# Development roadmap

Roadmap phases and numeric Pickup Order are planning and reporting metadata: they describe sequence and progress, not dispatch permission. Dependency-ready bounded leaves are dispatched in parallel across phases. The first objective is a visible definition-led application by the end of Phase 6: an authorized user navigates installed pages, browses/opens records, creates/edits a record, invokes declared actions and sees the installed theme. Generic engines render ordinary definitions; application names and business policies are not hardcoded.

[GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) · [Agent coordination](agent-coordination.md) · [Fleet procedure](agent-fleet.md) · [Workflow diagram](fleet-orchestration.html) · [Product specification](../specification/README.md)

The GitHub project roadmap is the execution plan. Issue bodies and native dependencies define bounded work. This page explains the phases; it does not duplicate live owner, status or estimate records. The [21 September architecture review](architecture-review-2026-09-21.md) records what was actually present on main at `e4cd4375958b91c55a5bd93b00c86656b98a8d13`.

## Architecture decisions of 25 September 2026

The [architecture decisions](architecture-decisions-2026-09-25.md) govern all remaining work: one Kestra-shaped flow definition run by the in-house Vortex flow engine, saving through one atomic operation, read-time computed fields, one configurable Records table, system modules for people, groups, roles and settings, application packages with sandboxed custom components, clean install and uninstall, and agent building through the same operations. Their work is placed in these scopes:

| Scope | Phase | Covers |
| --- | ---: | --- |
| [#990](https://github.com/Abzum-NZ/Abzum-Vortex/issues/990) | 4 | Readable database programs, read-time deadline values, access plan cache |
| [#976](https://github.com/Abzum-NZ/Abzum-Vortex/issues/976) | 4 | One Kestra-shaped flow language, protected-operation executor, flow runner prerequisites |
| [#999](https://github.com/Abzum-NZ/Abzum-Vortex/issues/999) | 5 | Theme vocabulary, Records table, layout and navigation blocks, responsive layout, interface tasks |
| [#1015](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1015) | 6 | Entry routing, administration access and operation wiring |
| [#1051](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1051) | 7 | Access operations, approvals as Kestra workflows, builder permissions |
| [#1025](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1025) | 7 | System modules for people, groups, roles, organisations and settings |
| [#1059](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1059) | 7 | One record-change path and leaner engine evidence |
| [#1079](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1079) | 8 | Access and filters inside list queries, runtime bundle cache |
| [#1085](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1085) | 9 | Runnable Kestra flows, one system actor, background jobs, custom scripts |
| [#112](https://github.com/Abzum-NZ/Abzum-Vortex/issues/112) | 11 | Application packages, custom components, clean uninstall |
| [#200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) | 10 | Agent building and use through MCP |

## Phases

| Phase | Functionality | Scope epic |
| ---: | --- | --- |
| 1 | Identity, access and current contracts | [#9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9) |
| 2 | Definitions, modules and storage | [#18](https://github.com/Abzum-NZ/Abzum-Vortex/issues/18) |
| 3 | Record changes and lifecycle | [#31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31) |
| 4 | Queries and current-user flows | [#42](https://github.com/Abzum-NZ/Abzum-Vortex/issues/42) |
| 5 | Application and page runtime | [#53](https://github.com/Abzum-NZ/Abzum-Vortex/issues/53) |
| 6 | First visible definition-led application | [#63](https://github.com/Abzum-NZ/Abzum-Vortex/issues/63) |
| 7 | Visual designers and start pages | [#75](https://github.com/Abzum-NZ/Abzum-Vortex/issues/75) |
| 8 | Search, files and query caching | [#87](https://github.com/Abzum-NZ/Abzum-Vortex/issues/87) |
| 9 | Workflows and delegated execution | [#98](https://github.com/Abzum-NZ/Abzum-Vortex/issues/98) |
| 10 | Connections and interfaces | [#109](https://github.com/Abzum-NZ/Abzum-Vortex/issues/109) |
| 11 | Sharing, copying and data exchange | [#164](https://github.com/Abzum-NZ/Abzum-Vortex/issues/164) |
| 12 | Privacy, retention and capability limits | [#165](https://github.com/Abzum-NZ/Abzum-Vortex/issues/165) |
| 13 | Operational functionality | [#166](https://github.com/Abzum-NZ/Abzum-Vortex/issues/166) |

## Pickup and phase completion

Select any unfinished leaf whose real dependencies are complete, preferring lower Pickup Order only to break ties between equally ready leaves, and keep several independent leaves moving at once. Parent/phase epics summarize their children and are not additional implementation assignments. Neither phase nor Pickup Order gates dispatch, so a blocked or missing number never idles Ready work; renumbering is a reporting correction, not a prerequisite. A forward dependency or cycle requires an explicit ordering correction against source and specification. Follow the [ready-work dispatch algorithm](agent-fleet.md#ready-work-dispatch-algorithm).

A phase label does not replace a dependency. Confirm each selected leaf's real Blocked by issues and prerequisite child scopes are complete before dispatch.

The orchestrator reads source before assignment, bounds the outcome/paths/exclusions/acceptance, chooses the cheapest capable model and updates metadata to match the actual assignment. Each issue proceeds through implementation, reviewer-owned fixes/re-review, permitted integration, issue closure, board reconciliation and cleanup, while every other independent leaf continues in its own lane.

Completion requires implemented functionality, independent source review and integration. No tests, database/hosted review, proof receipts, Kestra, Testing deployment or release gate is part of these phases. Phase 13 develops operational functionality in code; it does not authorize operating or deploying a hosted system.

## Phase 6 boundary

Identity/access, one current definition format, installation/storage, record operations, queries and page/form/application composition must connect into the existing Next.js UI. Include actual session/access decisions, initial operating access and declared action wiring. No fake permission bypasses, fixture-only result or hardcoded demo counts as the implemented application.

Application installation and initial operating access are explicit owning-service operations. The initial setup command binds a frozen server-owned manifest to the original provisioning receipt and nominated account. It installs exact releases and establishes only their named operating access. Ordinary application requests continue to use actual sessions and Access decisions; management status or first login never invents business permissions. The later governed access-request workflow is Phase 9.

The visual designer, search/files, durable workflow engine, connections, sharing and MCP remain in their assigned later tasks. A later engine extends the application definitions through its named task; it does not hold the Phase 6 UI behind a whole later phase. Product requirements live in the specification and bounded issue; old phase lists or evidence instructions do not override this current roadmap.

## Current representation

This is a new application. Application, Module and Group owners replace obsolete format branches at their source and update all consumers together. There is no requirement to preserve unused V1/V2/V3 readers, converters or compatibility fixtures. Normal immutable product releases, explicit installed-release selection and revisions remain product functionality.

## Estimates and progress

Use each leaf's named-agent active-minute estimate, separating implementation and review where useful. Parent and phase totals sum their leaves only; do not add them again. They are planning estimates of active work, not elapsed calendar deadlines. At the estimate or 30-minute checkpoint inspect actual progress and record remaining scope and revised estimate; do not terminate productive work automatically. Missing progress is investigated at 15 minutes. Phase and Pickup Order remain unchanged on reassignment.

The board holds live ownership, status and current estimate rollups; this document deliberately contains no duplicated live task counts or old completion receipts. The monitor reports after every scheduled run, including idle and blocker state, without inventing completion percentages.

## Historical plans

Earlier architecture notes, evidence and handoffs remain design and history references. Their test, deployment, proof, fixed-model and promotion instructions are superseded by [agent coordination](agent-coordination.md). Preserve relevant product requirements; do not import historical fleet procedures into new briefs.

The old fleet is archived at `C:/Users/vijay/orca/archives/vortex-20260922-reset`. Read its `SALVAGE.md` and `archive-manifest.json` before dispatch; use new sessions and selectively import useful product code. In particular, #49 has a stopped reviewed candidate, #50 has an uncommitted draft, and #407 contains only the merged inventory portion. Read their current issue metadata and existing worktrees before assigning remaining work.

## Working guidance

- [Agent coordination](agent-coordination.md)
- [Fleet operations and estimate checkpoints](agent-fleet.md)
- [Definition-led application delivery](engine-first-application-delivery.md)
- [Specification](../specification/README.md)
