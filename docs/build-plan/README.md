# Development roadmap

The first objective is a real, visible definition-led application by the end of Phase 6. A nominated user can navigate installed pages, browse and open records, create and edit a record, run a declared action and see the installed theme. Application names and business policies belong in definitions; generic engines and UI render those definitions.

The [GitHub project roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) is the execution plan. Issue bodies and native dependencies define bounded work. This page explains the phases; it does not duplicate live owner/status records. The [architecture review](architecture-review-2026-09-21.md) records what was actually present on main at `e4cd4375958b91c55a5bd93b00c86656b98a8d13`.

## Pickup order

Pick an open leaf task whose Blocked by issues are complete, in ascending Pickup Order. Parents group related subtasks and are not extra dispatches. Phase rollups are also not dispatches. A higher pickup number may run concurrently only when its actual dependencies are complete and its code ownership does not overlap active work. A phase label does not replace a dependency.

| Phase | Functionality | Scope owner | Remaining active estimate (hours) |
| ---: | --- | --- | ---: |
| 1 | Identity, access and current contracts | [#9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9) | 4.0 |
| 2 | Definitions, modules and storage | [#18](https://github.com/Abzum-NZ/Abzum-Vortex/issues/18) | 14.0 |
| 3 | Record changes and lifecycle | [#31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31) | 34.8 |
| 4 | Queries and current-user flows | [#42](https://github.com/Abzum-NZ/Abzum-Vortex/issues/42) | 23.0 |
| 5 | Application and page runtime | [#53](https://github.com/Abzum-NZ/Abzum-Vortex/issues/53) | 46.7 |
| 6 | First visible definition-led application | [#63](https://github.com/Abzum-NZ/Abzum-Vortex/issues/63) | 17.5 |
| 7 | Visual designers and start pages | [#75](https://github.com/Abzum-NZ/Abzum-Vortex/issues/75) | 51.9 |
| 8 | Search, files and query caching | [#87](https://github.com/Abzum-NZ/Abzum-Vortex/issues/87) | 58.8 |
| 9 | Workflows and delegated execution | [#98](https://github.com/Abzum-NZ/Abzum-Vortex/issues/98) | 97.3 |
| 10 | Connections and interfaces | [#109](https://github.com/Abzum-NZ/Abzum-Vortex/issues/109) | 70.5 |
| 11 | Sharing, copying and data exchange | [#164](https://github.com/Abzum-NZ/Abzum-Vortex/issues/164) | 65.8 |
| 12 | Privacy, retention and capability limits | [#165](https://github.com/Abzum-NZ/Abzum-Vortex/issues/165) | 32.5 |
| 13 | Operational functionality | [#166](https://github.com/Abzum-NZ/Abzum-Vortex/issues/166) | 40.0 |

These estimates are planning estimates for the named model's active implementation plus ordinary review corrections. They are not elapsed calendar deadlines. Parent and phase figures are sums of their leaves; do not add them again. When elapsed active work exceeds its estimate, the orchestrator inspects the actual diff and remaining scope, records the reason and adjusts or splits the work. Thirty minutes without useful progress also merits a checkpoint; neither trigger automatically kills a worker.

## Phase 6 boundary

The early path is identity/access, one current definition format, record changes, Query/current-person flows, page/form/application runtime, administration and business definitions, then the actual Next.js composition in #327. Application installation and initial operating access are explicit owning-service operations. Management status or first login never invents business permissions.

The initial setup command binds a frozen server-owned manifest to the original provisioning receipt and nominated account. It installs exact releases and establishes only their named operating access. Ordinary application requests continue to use actual sessions and Access decisions. The later governed access-request workflow is Phase 9.

Visual authoring is Phase 7. Search/files are Phase 8. Durable workflows and delegated execution are Phase 9. Connections/interfaces, sharing/data exchange, privacy/limits and operations follow. A later engine extends the application definitions through its named task; it does not hold the Phase 6 UI behind a whole later phase.

## Current representation

This is a new application. Application, Module and Group owners replace obsolete format branches at their source and update all consumers together. There is no requirement to preserve unused V1/V2/V3 readers, converters or compatibility fixtures. Normal immutable product releases, explicit installed-release selection and revisions remain product functionality.

## Assignment and completion

Use the provider-balanced routing in [Agent fleet](agent-fleet.md): OpenCode GLM, Antigravity Gemini Flash High, Claude Sonnet, and Opus/Sol for difficult work. The coordinator checks Claude/Codex usage before pickup and can change the planned agent, estimate and metadata. Process one issue at a time. A separate Opus 5 or Sol review-and-fix agent fixes its findings, re-reviews the final code and closes the task after integration.

Each leaf is complete when its stated functionality is implemented and accepted through code review. Do not create or run tests, require database or hosted review, collect proof receipts or screenshots, or create acceptance gates for this development plan. Existing test utilities are not a task prerequisite. Product permissions, transaction integrity, accessible UI behaviour and safe errors remain implementation requirements.

The old fleet is archived at `C:/Users/vijay/orca/archives/vortex-20260922-reset`. Read `SALVAGE.md` before dispatch; use new sessions and selectively import useful product code. In particular, #49 has a stopped reviewed candidate; #50 has an uncommitted draft; #407 contains only the merged inventory portion. Read their current issue metadata and existing worktrees before assigning remaining work.

The current documentation change removes obsolete delivery requirements; it does not authorize Production activity. Future operational deployment remains a separate decision.

## Working guidance

- [Agent coordination](agent-coordination.md)
- [Agent fleet and estimate checkpoints](agent-fleet.md)
- [Definition-led application delivery](engine-first-application-delivery.md)
- [Specification](../specification/README.md)

Older dated reviews and handovers describe historical sessions. Their verification, compatibility, branch-promotion and closure instructions are superseded by this roadmap and the current issue body.
