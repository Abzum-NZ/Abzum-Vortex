# Development roadmap

Work through the GitHub roadmap phases in numerical order and maintain numeric Pickup Order within each phase. The first objective is a visible definition-led application by the end of Phase 6: an authorized user navigates installed pages, browses/opens records, creates/edits a record, invokes declared actions and sees the installed theme. Generic engines render ordinary definitions; application names and business policies are not hardcoded.

[GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) · [Agent coordination](agent-coordination.md) · [Fleet procedure](agent-fleet.md) · [Workflow diagram](fleet-orchestration.html) · [Product specification](../specification/README.md)

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

Select the lowest unfinished leaf in the earliest incomplete phase. Parent/phase epics summarize their children and are not additional implementation assignments. Do not skip a blocked pickup, renumber the queue or advance phases without completing required work. A forward dependency, missing/duplicate number or cycle requires an explicit ordering correction, not silently selecting another issue. Follow the [strict pickup algorithm](agent-fleet.md#strict-pickup-algorithm).

The orchestrator reads source before assignment, bounds the outcome/paths/exclusions/acceptance, chooses the cheapest capable model and updates metadata to match the actual assignment. One issue proceeds through implementation, reviewer-owned fixes/re-review, permitted integration, issue closure, board reconciliation and cleanup before the next pickup.

Completion requires implemented functionality, independent source review and integration. No tests, DB/hosted review, proof receipts, Kestra, Testing deployment or release gate is part of these phases. Phase 13 develops operational functionality in code; it does not authorize operating or deploying a hosted system.

## Phase 6 boundary

Identity/access, one current definition format, installation/storage, record operations, queries and page/form/application composition must connect into the existing Next.js UI. Include actual session/access decisions, initial operating access and declared action wiring. No fake permission bypasses, fixture-only result or hardcoded demo counts as the implemented application.

The visual designer, search/files, durable workflow engine, connections, sharing and MCP remain in their assigned later tasks. Product requirements live in the specification and bounded issue; old phase lists or evidence instructions do not override this current roadmap.

## Estimates and progress

Use each leaf's named-agent active-minute estimate, separating implementation and review where useful. Parent/phase totals sum leaves only. At the estimate or 30-minute checkpoint inspect actual progress and record remaining scope and revised estimate; do not terminate productive work automatically. Missing progress is investigated at 15 minutes. Phase/Pickup Order remains unchanged on reassignment.

The board holds live ownership and status; this document deliberately contains no duplicated live task counts or old completion receipts. The monitor reports after every scheduled run, including idle/blocker state, without inventing completion percentages.

## Historical plans

Earlier architecture notes, evidence and handoffs remain design/history references. Their test, deployment, proof, fixed-model and promotion instructions are superseded by [agent coordination](agent-coordination.md). Preserve relevant product requirements; do not import historical fleet procedures into new briefs.
