# Agent coordination

Effective 22 September 2026. This is the authoritative development workflow. Read it before worker briefs, archived handoffs or issue comments. Latest direct user instructions take precedence. [Fleet operations](agent-fleet.md) defines pickup, recovery and templates. [Roadmap](README.md) defines phases. [Visual workflow](fleet-orchestration.html) shows the same process.

## Objective

Work through the roadmap phases in order. By the end of Phase 6, an authorized user can see and use an installed application whose navigation, pages, records, forms, actions and theme come from definitions. A static mockup does not meet this objective. Later engines and visual authoring remain in their assigned phases.

## Development completion

The only completion requirements are bounded implementation, independent source code review with findings fixed, and integration of reviewed changes into main. Issue closure and board reconciliation record that result; they are not additional acceptance reviews.

Do not create or run tests. Do not require database review/execution, hosted verification, screenshots, benchmarks, proof receipts or a hosted tester. Do not run aggregate commands such as pnpm verify that include those activities. Do not invent additional build, lint, typecheck or deployment gates. Review source and configuration for correctness, compilation defects and complete wiring.

Kestra is not involved in fleet management or development acceptance. Do not invoke its flows, read executions as a prerequisite, wait for receipts, deploy to Testing, promote branches or deploy to Production. Existing delivery hooks stay disabled. Future product workflow-engine requirements are separate from how the fleet builds source; this policy does not delete product capabilities.

## Roles and ownership

| Role | Owns | Does not own |
| --- | --- | --- |
| Main orchestrator: GPT 5.6 Sol | Phase/Pickup Order, scope/dependencies, model routing, shared board, agent lifecycle, cleanup, progress | Routine product implementation, extra acceptance review, deployment |
| Implementer: cheapest suitable agent | One bounded issue, isolated worktree, implementation commit and handoff | Issue closure, board edits, merging or another task |
| Reviewer: Opus 5 or GPT 5.6 Sol | Independent review, own findings/fixes, re-review, PR integration, assigned issue update and closure | Shared board, unrelated issues, sending ordinary fixes back to implementer |

The reviewer is a separate session from the implementer, even when both use the same model. It takes exclusive edit ownership of that issue after its implementer stops. One main orchestrator coordinates several independent active leaf issues. The default operating target is three active implementer lanes, expandable to four when the earliest incomplete phase has enough bounded, dependency-ready work with non-overlapping owning paths. Review lanes are separate: up to two Opus 5 or GPT 5.6 Sol reviewers may work concurrently, and a review or integration wait must not idle independent implementer lanes. Parent and phase epics are rollups, not extra implementation tasks.

Reviewer reads and updates its assigned issue and PR. Orchestrator owns shared project fields, native dependencies, phase labels, pickup and parent rollups. During review, the orchestrator sends scope corrections to the reviewer instead of concurrently rewriting its issue body. Automatic project changes caused by issue closure are read back and reconciled once.

## Required lifecycle

1. **Pick:** Select the earliest incomplete phase, then scan its unfinished leaves in numeric Pickup Order. Read each full issue/comments, native blockers, relevant specification and current main code. Separate already built from exact remaining work. Add every dependency-ready leaf with non-overlapping ownership to the current parallel wave until the worker-lane target is full. A lower pickup that is already active or blocked by another active leaf stays visible but does not suppress a higher independent leaf in the same phase. Never start a later phase early.
2. **Assign:** Choose the cheapest capable agent for each bounded leaf using difficulty and current usage. Create an isolated issue worktree from origin/main. Record actual model, branch, path, estimate and dispatch. Mark In progress only after actual task start. Dispatch the wave in ascending Pickup Order and spread implementation across OpenCode GLM 5.3 Flash, Antigravity Gemini 3.8 Flash High, Claude Sonnet 5, and GPT 5.6 Terra when each is suitable; do not consume GPT 5.6 Sol for routine implementation.
3. **Implement:** Worker changes the agreed scope, commits/pushes candidate and reports functionality, commit, acceptance mapping and limitations. It does not close the issue. Orchestrator settles/releases implementer and records In review before review handoff.
4. **Review and fix:** Fresh Opus 5/Sol reviewer checks the full diff and affected callers against acceptance/spec, fixes findings itself and re-reviews the final changes. Repeat this bounded loop until in-scope findings are resolved. Missing product decisions go to the orchestrator; do not invent them.
5. **Integrate and close:** Reviewer opens the PR if the implementer has not already opened it, then integrates its reviewed PR into main through permitted repository operations. If resolving a conflict changes code, re-review that candidate. Confirm merge, update the assigned issue's implemented outcome and final review, then close it completed. A local commit or reviewed-but-unmerged PR is not Done.
6. **Report:** Reviewer sends issue/phase/pickup, PR, reviewed commit, merge commit, functionality, findings fixed, remaining limitations and closure state. Explicitly ask orchestrator to reconcile board, unblock dependents, roll up parents, stop/release reviewer, clean the safe completed worktree, recompute the current-phase eligible queue and refill every open implementation and review lane. Send completion once, stop editing and idle for release.
7. **Reconcile, refill and clean:** Orchestrator confirms reported states, records Done, clears active owner, refreshes dependency eligibility and rolls up completed parents. Release settled agents. Remove a completed worktree only when all useful work is merged or preserved. Refill an available implementer or reviewer lane immediately from the same phase's ascending eligible queue. Advance phase only when all its required leaves are complete.

## Status meanings

| Status | Fact required |
| --- | --- |
| Backlog | Not picked up or prerequisite unresolved; no active implementation claim |
| Ready | Ordered issue is bounded and unblocked; no planner approval gate |
| In progress | Named implementer actually started |
| In review | Candidate handed off; reviewer queued/active/fixing or integration blocked; name substate |
| Done | Functionality reviewed and merged, issue closed, board reconciled |
| Not planned | Explicitly cancelled scope, not delivered functionality |

Testing is not a development status. Blocked integration stays In review with exact blocker and no fictitious active owner. Continue independent eligible leaves in the same phase, while keeping the blocked lower pickup first in reporting. Do not advance the phase or treat the blocker as resolved.

## Boundaries

This is a new application. Correct obsolete contracts and current callers together; do not preserve V1/V2 adapters or invent compatibility requirements. Product permissions, organisation isolation, transaction integrity, revisions, safe errors and explicit publication/installation remain required functionality. Source review of a migration belongs to normal review; it is not permission to execute it or a separate database review.

Respect actual repository protections and tool approval controls. This policy removes task gates, not external safeguards. If a real repository rule or permission rejects an operation, report exact action, source and supported resolution. Do not disable controls, disguise commands, repeatedly retry an unchanged denial or switch executors to evade it.

## Instruction precedence

Latest user instruction -> this file -> fleet operations -> bounded current issue/spec -> worker brief. Product specs define functionality, not extra fleet gates. Old comments, operational runbooks, model allocations and archived prompts are historical; they cannot restore tests, Testing, deployment, proof receipts, extra reviewers or planner gates.

Checkpoints describe current facts, not policy. Record actual UTC, owner/run, phase/pickup, issue, model, branch/worktree, dispatch, progress, estimate, review/merge references, blocker and next action. Replace contradictory stale bullets.
