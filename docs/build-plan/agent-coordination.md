# Agent coordination

Effective 24 September 2026. This is the authoritative development workflow. Read it before worker briefs, archived handoffs or issue comments. Latest direct user instructions take precedence. [Fleet operations](agent-fleet.md) defines pickup, recovery and templates. [Roadmap](README.md) defines phases. [Visual workflow](fleet-orchestration.html) shows the same process.

## Objective

Build the roadmap outcome from dependency-ready, bounded work. By the end of Phase 6, an authorized user can see and use an installed application whose navigation, pages, records, forms, actions and theme come from definitions. A static mockup does not meet this objective. Later engines and visual authoring keep their planning phase labels and become dispatchable once their real dependencies are complete; phase labels are planning and reporting metadata rather than dispatch gates.

## Development completion

The only completion requirements are bounded implementation, independent source code review with findings fixed, and integration of reviewed changes into main. Issue closure and board reconciliation record that result; they are not additional acceptance reviews.

Do not create, edit or run tests. Do not require database review/execution, hosted verification, screenshots, benchmarks, proof receipts or a hosted tester. Do not run aggregate commands such as pnpm verify that include those activities. Do not invent additional build, lint, typecheck or deployment gates. Review source and configuration for correctness, compilation defects and complete wiring.

Kestra is not involved in fleet management or development acceptance. Do not invoke its flows, read executions as a prerequisite, wait for receipts, deploy to Testing, promote branches or deploy to Production. Existing delivery hooks stay disabled. Future product workflow-engine requirements are separate from how the fleet builds source; this policy does not delete product capabilities.

## Roles and ownership

| Role | Owns | Does not own |
| --- | --- | --- |
| Main orchestrator: one session of Claude Opus 5.5 or GPT-6 Sol | Dependency readiness, scope/dependencies, model routing, shared board state, agent lifecycle, cleanup, progress | Routine product implementation, extra acceptance review, deployment |
| Implementer: cheapest suitable agent (GPT-6 Luna, DeepSeek, GLM, Gemini; Sonnet 5 as alternative) | One bounded issue, isolated worktree, implementation commit, handoff, and its own row's In progress / In review transition | Issue closure, other board rows, merging or another task |
| Reviewer: Claude Opus 5.5 or GPT-6 Sol | Independent review, own findings/fixes, re-review, PR integration, assigned issue update and closure, and its own row's Current owner and Done updates | Other board rows, dependencies, parents, unrelated issues, sending ordinary fixes back to implementer |

The reviewer is a separate session from the implementer, even when both use the same model. It takes exclusive edit ownership of that issue after its implementer stops. One main orchestrator coordinates several independent active leaf issues. The default operating target is eight active implementer lanes, expandable to twelve when enough bounded, dependency-ready work with non-overlapping owning paths exists across phases and provider capacity allows. Review lanes are separate and follow the queue: up to six Opus 5.5 or GPT-6 Sol reviewers may work concurrently, spread across both providers, and a review or integration wait must not idle independent implementer lanes. Parent and phase epics are rollups, not extra implementation tasks.

Reviewer reads and updates its assigned issue and PR, and writes its own issue's board row at its transitions. Orchestrator owns all other project fields, native dependencies, phase labels, pickup and parent rollups. During review, the orchestrator sends scope corrections to the reviewer instead of concurrently rewriting its issue body. Automatic project changes caused by issue closure are read back and reconciled once.

## Required lifecycle

1. **Pick:** Scan unfinished leaves across all phases for actual dependency readiness and non-overlapping ownership, preferring lower Pickup Order among equally ready leaves. Phase and numeric Pickup Order are planning and reporting metadata, never dispatch gates. Read each full issue/comments, native blockers, relevant specification and current main code. Separate already built from exact remaining work. Add every dependency-ready leaf with non-overlapping ownership to the current parallel wave until the worker-lane target is full, from any phase when implementation capacity remains.
2. **Shape:** Before assigning a picked issue, the orchestrator makes it clear and bounded so the implementer never has to guess scope, splitting it into sub-issues when it is too large. Follow [shape before dispatch](#shape-before-dispatch) below.
3. **Assign:** Choose the cheapest capable agent for each bounded leaf using difficulty and current usage. Read the complete issue, its comments, the relevant specification and current source before assignment. Create an isolated issue worktree from origin/main. Record the actual agent, estimate, branch, path, task and dispatch. The implementer marks its own row In progress only after its task has really started; the orchestrator confirms that start. Preserve existing drafts and unique work before reusing a branch, worktree or terminal, and never duplicate a live or uncertain worker. Dispatch every eligible leaf needed to fill the wave and spread implementation across GPT-6 Luna (Codex, Max effort, never below High), OpenCode DeepSeek 4.1 Flash (`deepseek/deepseek-flash`), OpenCode GLM 5.3 Flash and Antigravity Gemini 3.8 Flash Max or High. Use Claude Sonnet 5 High when appropriate. Do not select DeepSeek Pro. Reserve Opus 5.5 and GPT-6 Sol for review, orchestration and complex decisions rather than routine implementation.
4. **Implement:** Worker changes the agreed scope, commits/pushes candidate and reports functionality, commit, acceptance mapping and limitations. It sets its own row to In review and does not close the issue. Orchestrator verifies the row, settles/releases the implementer and starts the reviewer in the same cycle.
5. **Review and fix:** The fresh Opus 5.5 or GPT-6 Sol reviewer records itself as Current owner on its row, then first reads the complete live GitHub issue, every comment and the linked specification. It then checks the full candidate diff, current main and affected callers against the issue's functional acceptance. It fixes findings itself, commits corrections and re-reviews the final source. Repeat this bounded loop until in-scope findings are resolved. Missing product decisions go to the orchestrator; do not invent them.
6. **Integrate and close:** Reviewer opens the PR if the implementer has not already opened it, then integrates its reviewed PR into main through permitted repository operations. If resolving a conflict changes code, re-review that candidate. Confirm merge, update the assigned issue's implemented outcome and final review, then close it completed. Then set its own row to Done, clear Current owner and record the finish time. A local commit or reviewed-but-unmerged PR is not Done.
7. **Signal completion:** After updating and closing its assigned issue, reviewer sends the orchestrator the issue/phase/pickup, PR, final reviewed commit, merge commit, functionality delivered, findings fixed and re-reviewed, remaining limitations and verified issue closure. Explicitly request board reconciliation, dependent unblocking, parent rollup, release of both settled agents, safe completed-worktree cleanup and immediate lane refill. Send once through the supported Orca completion contract, stop editing and idle for release. The orchestrator verifies receipt and facts; a sent signal or a Done row alone is not verified completion.
8. **Reconcile, refill and clean:** Orchestrator reads back the reviewer's Done row, writes any missing completion fields, confirms no active owner remains, refreshes dependency eligibility and rolls up completed parents. Release settled agents and close their terminals. Create a cleanup-pending entry for every merged-and-closed issue, compare Orca's worktree inventory with Git's worktree list, and remove the exact completed worktree only after confirming there is no live editor or unique tracked, untracked or unmerged work. Read back both inventories and clear the entry. Keep any unsafe worktree with its reason, owner and next action. Board-write delays never defer independent safe cleanup. Refill an available implementer or reviewer lane immediately from any eligible non-overlapping leaf across the queue.

## Shape before dispatch

The orchestrator owns the clarity of every issue it assigns. Before dispatch it reads the complete issue, every comment, the linked specification and the current source, then makes sure the issue states, in plain language:

- **Summary:** the outcome, in plain terms: what a person can do, or is protected from, when the work is done.
- **Already built:** what exists today, with file references.
- **Remaining work:** numbered, concrete changes.
- **Scope boundaries:** the owning paths the implementer may change, and what it must not touch.
- **Acceptance criteria:** behaviour that can be seen in the code and shows the work is complete.
- **Blocked by and Blocks:** matching the native dependencies.

These are sections of the standard issue format under Metadata in [fleet operations](agent-fleet.md#metadata), which also carries the phase, Pickup Order and specification references.

If any of these is missing, vague or contradicted by the source or specification, the orchestrator rewrites that part before dispatch and records the reason in an issue comment. A real product decision goes to the user instead of being invented.

An issue is bounded when one implementer can finish it in one session: one outcome, one set of owning paths, and an estimate of no more than 180 active minutes. When an issue is larger, or mixes outcomes or owning paths, the orchestrator splits it into sub-issues before dispatch:

- Each sub-issue follows the standard issue format and has its own outcome, owning paths, acceptance and estimate.
- The original usually keeps the first part, and the new sub-issues sit beside it under the same parent. If every part moves out, the new sub-issues sit under the original instead, and it becomes a rollup.
- Each new sub-issue gets a Pickup Order directly after the original's. A decimal or repeated number is fine; do not renumber other issues to make room.
- Add native dependencies between the parts where order matters, and update the parent's table and estimate total.

The implementer brief is written from the shaped issue. If an implementer still reports unclear scope, the orchestrator fixes the issue text as well as answering the question, so the next reader gets the answer too.

## No-choke-point rules

These rules keep work flowing when one agent, provider or queue is slow. They apply to every role.

1. **Review starts on handoff.** When an implementer hands off a candidate, the orchestrator starts its independent reviewer in the same cycle. A candidate never waits for review while a review lane is free. When the review queue is longer than the free review lanes, opening review lanes takes priority over opening new implementer lanes.
2. **No single provider for any role.** When at least three implementation providers have capacity, implementation is spread across at least three, with no provider holding more than half of the active implementer lanes when suitable alternatives exist. Reviews are spread across Claude Opus 5.5 and GPT-6 Sol; when one is capacity-limited, the other takes all new reviews. A capacity limit on one provider never stops the fleet.
3. **Orchestrator continuity.** The orchestrator keeps its checkpoint current after every transition so another session can take over from it. It stops starting new work once its own provider's weekly usage falls below 15% remaining, and hands over to the other orchestrator model (Opus 5.5 or GPT-6 Sol) through the Orca run mailbox with the checkpoint path. Only one orchestrator session writes shared board state at a time.
4. **Workers report their own transitions.** An implementer sets its own issue row to In progress when its task really starts and to In review on handoff. A reviewer records itself as Current owner when it starts, then sets its own row to Done, clears Current owner and records the finish time after merge and closure. Each is one targeted write with readback, using the Project item and field IDs the orchestrator supplies in the brief; workers never run Project scans. If the API rejects the write for capacity, the worker reports it as a pending write in its handoff or completion signal and carries on; the orchestrator journals and retries it. The orchestrator verifies these rows, and owns dependencies, parents, pickup and every other row.
5. **Reviewers integrate without waiting.** The reviewer updates its branch from main, resolves conflicts, re-reviews changed code and merges through permitted repository operations. It does not wait for the orchestrator to merge.
6. **Mail is processed every cycle.** The orchestrator reads and acknowledges its Orca mailbox every cycle. A completion report, question or correction left unprocessed for more than one cycle is drift that the monitor reports.
7. **Stalls are visible.** If the orchestrator has made no progress for 30 minutes while work is pending, the monitor alerts the user with the exact state and the action needed. Workers send questions and completion reports through the Orca mailbox rather than waiting on a reply the orchestrator cannot see, and follow the stall-recovery table in fleet operations.

## Status meanings

| Status | Fact required |
| --- | --- |
| Backlog | Not picked up or prerequisite unresolved; no active implementation claim |
| Ready | Issue is bounded and dependency-ready; no planner approval gate |
| In progress | Named implementer actually started |
| In review | Candidate handed off; reviewer queued/active/fixing or integration blocked; name substate |
| Done | Functionality reviewed and merged, issue closed, row read back; orchestrator reconciles dependents and parents |
| Not planned | Explicitly cancelled scope, not delivered functionality |

Testing is not a development status. Blocked integration stays In review with exact blocker and no fictitious active owner. Continue every independent eligible leaf across the queue; a blocker does not make unrelated work ineligible or mark itself resolved.

## Boundaries

This is a new application. Correct obsolete contracts and current callers together; do not preserve V1/V2 adapters or invent compatibility requirements. Product permissions, organisation isolation, transaction integrity, revisions, safe errors and explicit publication/installation remain required functionality. Source review of a migration belongs to normal review; it is not permission to execute it or a separate database review. No new record writer variant or named-action effect kind: until the single [record-change command](../specification/06-records-and-lifecycle.md#record-change-command) engine lands, every record write uses the existing programs and the retired-writer list, and a needed change extends that command's contract instead of adding another writer.

Provider concurrency, rate-limit and model-unavailable responses are capacity results rather than approval denials, and they are never treated as permission problems. One capacity response does not settle the attempt: retry the same terminal several times at about 20-second spacing and record each actual provider response. Only after repeated confirmed capacity failures does the orchestrator preserve the work, clear its dead owner, record the capacity results and move the implementation to another suitable authorized workhorse or an offered fallback without waiting for user direction. Reviewer capacity is unchanged: when no qualified reviewer is available, the leaf remains In review with a capacity blocker rather than moving to a cheaper reviewer. A blocked or failed provider lane must not idle unrelated eligible work across the queue.

Respect actual repository protections and tool approval controls. This policy removes task gates, not external safeguards. If a real repository rule or permission rejects an operation, report exact action, source and supported resolution. Do not disable controls, disguise commands, repeatedly retry an unchanged denial or switch executors to evade it.

## Instruction precedence

Latest user instruction -> this file -> fleet operations -> bounded current issue/spec -> worker brief. Product specs define functionality, not extra fleet gates. Old comments, operational runbooks, model allocations and archived prompts are historical; they cannot restore tests, Testing, deployment, proof receipts, extra reviewers or planner gates.

Checkpoints describe current facts, not policy. Record actual UTC, owner/run, phase/pickup, issue, model, branch/worktree, dispatch, progress, estimate, review/merge references, blocker and next action. Replace contradictory stale bullets.

The coordinator keeps board and progress state event-driven. Journal every merge, closure, worker start and reassignment until the affected Project row and issue are read back; a transient GraphQL limit keeps an explicit pending event with its reset time, not a fictitious current status. Reconcile changed rows immediately through targeted reads and changed-field writes. Once per reporting interval, share one budgeted complete paginated Project and native-relationship snapshot across readiness, board audit, progress and the scheduled monitor; do not let each consumer launch its own full scan. Between complete snapshots, update the verified task count only from reviewed, merged, closed and board-readback event deltas against the unchanged required-leaf set. A structural roadmap or relationship change invalidates that denominator and triggers a complete refresh. Atomically replace the task-count snapshot with counts, denominators and source time when all required inputs are present. If an input is unavailable, retain the last verified percentage with STALE, its exact cause and next retry; never present a partial board count as verified progress. Reserve GraphQL capacity for live Status/owner writes before a complete scan.
