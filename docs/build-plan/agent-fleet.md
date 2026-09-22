# Fleet operations

Read [agent coordination](agent-coordination.md) first. This procedure governs the GPT 5.6 Sol main orchestrator, implementers and Opus 5.5 / GPT 5.6 Sol reviewers. [Visual workflow](fleet-orchestration.html).

## Ready-work dispatch algorithm

1. On startup/resume, inspect current coordinator/run, workers and worktrees. Adopt ownership only through supported Orca operations. Never duplicate a live or uncertain worker. Reconcile ownership ambiguity before dispatching the affected issue. Pending reports or status writes for one issue remain in the reconciliation journal and do not stop independent eligible work.
2. Read all pages of the configured authoritative roadmap project: required leaves, phase, status, native blockers, parent relationships and Pickup Order metadata. The concrete repository and project identifiers belong in coordinator runtime state, not this policy. Cache the queue for the cycle. Refresh active/next items at each transition and the complete queue every 30 minutes or after a roadmap change. A partial view cannot establish an empty queue or completed required leaves.
3. Scan every non-rollup, non-cancelled leaf across all phases. Reviewed but unmerged is unfinished. Phase and Pickup Order are planning and reporting metadata, not dispatch gates; implementation eligibility is governed by actual dependencies, bounded scope, exclusive owning paths and available capacity.
4. Keep active work in place, then dispatch every dependency-ready, independently bounded leaf whose owning paths do not overlap an active editor until the lane target is full. Phase never limits that selection; prefer lower Pickup Order only to break ties between equally ready leaves. A leaf is ineligible only because of a real dependency, overlapping ownership, unresolved scope or unavailable capacity.
5. Confirm the selected leaf's real native blockers and required children are complete. Correct stale dependency descriptions against source/spec with a recorded reason. Never delete a real dependency merely to make the task Ready.
6. A dependency cycle or contradictory native dependency is a planning blocker. Pickup Order may remain missing, duplicated or out of sequence because it is reporting metadata; never wait for or renumber it before dispatching Ready work.
7. Read current source and bound remaining work for enough eligible leaves to maintain six active implementer lanes by default, or eight when isolation and capacity are clear. Already implemented functionality goes to a bounded Opus/Sol source review and completion reconciliation, not reimplementation. Otherwise select routing/estimate and dispatch the implementer.
8. Treat implementer and reviewer capacity as separate pools. Up to four independent Opus 5.5 or GPT 5.6 Sol review-and-fix sessions may run concurrently. A candidate waiting for review, repository status, or integration does not consume an implementer lane and does not pause independent work elsewhere in the queue.
9. After any candidate handoff, reviewed integration, issue closure, board reconciliation or cleanup, immediately recompute eligibility and refill open lanes. Phase 6 means implemented definition-led UI, not deployment or hosted evidence; phase completion is a reporting rollup, not a dispatch gate.

Phase labels and Pickup Order are preserved as planning/reporting metadata, while real dependencies, bounded scope, exclusive ownership and capacity determine readiness. Resolve external blockers or name the exact action needed; keep every independent Ready leaf across the queue moving. Provider changes and revised estimates never change readiness. Do not go silently idle or claim an empty queue while eligible work or an unfilled lane remains.

## Models and capacity

| Work | Preferred model |
| --- | --- |
| Main orchestrator | GPT 5.6 Sol (Codex - High) |
| Mechanical changes, explicit schemas/catalogues/adapters | GLM 5.3 Flash (OpenCode) |
| Bounded UI components, pages and wiring | Gemini 3.8 Flash (Antigravity - Max or High) |
| Ordinary runtime/service implementation | Claude Sonnet 5 (High) |
| Complex architecture, authorization or transactions | Claude Opus 5.5 (High), or GPT 5.6 Sol when capacity favours it |
| Alternative bounded implementation | GPT 5.6 Terra, or GPT 5.6 Luna High for clearly defined bounded work |
| All final reviews, fixes and re-reviews | Opus 5.5 or GPT 5.6 Sol (High), separate session from implementer |

Choose the cheapest capable model. Before dispatch, review handoff and each 30-minute active checkpoint, read `orca account list --json` for Claude and Codex session and weekly usage, reset times, freshness and errors. GLM and Antigravity capacity may require observing the actual provider response. Unknown quota is not unlimited. Capacity guidance does not permit ignoring real dependencies, unresolved scope or exclusive ownership. Avoid routine implementation below 25% weekly remaining; preserve 15% for essential coordination/review. No automatic credit purchases or resets. If both qualified reviewers are unavailable, remain In review with a capacity blocker; do not substitute a cheaper reviewer or claim Done.

Treat a provider concurrency, rate-limit or model-unavailable response as a capacity result, not a tool-approval denial. One capacity response does not settle the attempt: retry the same terminal several times at about 20-second spacing and record each actual provider response. Only after repeated confirmed capacity failures preserve the branch/worktree, settle that attempt and move implementation to the next cheapest suitable authorized workhorse or an offered fallback, without waiting for user direction. Real permission and repository-protection denials remain non-bypassable: do not retry unchanged, change controls or route through another executor to evade them.

For implementation waves, distribute work across qualified providers instead of filling every lane with one provider. Prefer GLM for mechanical contract/catalogue work, Gemini 3.8 Flash Max or High for bounded UI and wiring, Sonnet 5 High for ordinary runtime/service work, Terra for bounded general implementation, and Luna High only when the task is clearly defined and bounded. Unknown usage telemetry is not proof that an installed provider cannot execute, and unknown Gemini or Antigravity usage in particular is not evidence of inability; use a real bounded launch to establish availability when that model is the best fit, then record the actual result. Avoid assigning more than half of active implementer lanes to one provider when equally suitable alternatives are available. Opus 5.5 and GPT 5.6 Sol are reserved for review, complex decisions and orchestration.

Verify actual model/effort in launch/session; planned labels are not execution facts. Resolve provider and model identifiers from the current Orca runtime configuration at dispatch, confirm the actual session identity, and record it in the checkpoint. Never label another version as the requested model. Reassignment updates planned agent, estimate, actual worktree display name, issue metadata and parent row together. Retain an existing branch name accurately when appropriate.

## Workhorse terminal launch

Launch each provider through its normal supported path and judge readiness by actual session state rather than cosmetic output.

| Provider | Normal launch | Readiness and recovery |
| --- | --- | --- |
| Antigravity Gemini 3.8 Flash | `agy-trusted.cmd` | Ready when the session reports `agentWait: None`. The sign-in banner is cosmetic; it is not a blocker, a capacity result or a permission denial. |
| OpenCode GLM 5.3 Flash | `opencode` | A TinyCC or OpenTUI initialization failure means the Windows ARM64 architecture fix must be re-applied and that terminal relaunched. It is not a capacity or permission result. |

A GLM concurrency-capacity response is a capacity result on an otherwise healthy terminal: retry the same terminal several times at about 20-second spacing rather than relaunching it, reclassifying it as a permission problem or settling the leaf. Move the leaf to another workhorse or an offered fallback only after repeated confirmed capacity failures.

## Metadata

Each leaf title starts #<issue>. Include phase label, numerical pickup, plain Summary, Already built, What will be built, scope boundaries, functional acceptance, specification references, Blocked by and Blocks. No test instructions or proof checklists.

Record planned implementer, reviewer, active-minute implementation/review estimates, actual worktree/branch, current owner, task/dispatch/session, UTC start/finish, last useful progress, PR/reviewed/merged commits and blocker. Worktree display name: #<issue> - <agent>. Default new branch: codex/<issue>-<agent-slug>; always record the branch actually created. Parent estimates total children, not additional effort. Queued/blocked minutes are separate from active time.

## Board reconciliation

Orchestrator is the sole project-board writer. Reviewer is explicitly allowed to update/close its assigned issue and manage its PR. Update at every event:

| Event | Board action |
| --- | --- |
| Dependency-ready issue bounded | Ready, planned model/estimate, no active owner yet |
| Actual worker start | In progress, actual model/dispatch/branch, UTC start |
| Implementation complete | In review, candidate commit, implementer cleared, reviewer queued/started |
| Reviewer starts/fixes | In review, actual reviewer, review/fix substate, current candidate |
| Blocker/provider failure/exit | Truthful stage, exact reason, owner, next action and resume condition; clear dead owner |
| Reassignment | Issue, parent row and board reflect new actual agent/estimate/worktree |
| Reviewer reports merged/closed | Orchestrator writes Done, merge/review references, finish time, no active owner, dependent eligibility refreshed |
| Cleanup/phase completion | Lifecycle outcome recorded, parent/phase rolled up from completed required leaves |

Issue closure and project writes are separate. Resolve the coordinator-state root from the current checkpoint/runtime configuration and maintain one short `board-reconciliation.jsonl` entry per event there: issue, intended fields, source commit/PR, UTC and pending/done. Read back the affected issue/item after writing. On interruption, inspect current state and retry only missing authorized updates; do not duplicate comments or repeatedly reopen/close an issue. Mark transient failure board-sync-pending. Pending writes for one issue do not stop independent eligible leaves; retain and retry them through the journal. Use a local note, not a new coordination database/service.

After each reviewed merge and issue closure, write the board event immediately and read back its fields. A rate limit or temporary API failure leaves an explicit pending event with the reported reset/retry time; check fresh API capacity rather than trusting an old reset estimate. Drain pending events as soon as the API recovers, including while other agents work. A closed issue still showing In review or In progress, or a started worker still showing Backlog or Ready, is board drift to repair at this transition, not at a later phase boundary.

After board reconciliation and before each scheduled progress report, recompute `monitor-progress.json` from all paginated Project items, all native parent/subissue relationships, and review, main-merge, issue-closure and board-readback evidence for every required leaf. Exclude rollup parents, phase epics, cancelled/duplicate/not-planned leaves and administrative PRs. Write a complete snapshot atomically with fetched/total counts, source UTC, completed/required counts and percentages for the full roadmap and Phases 1–6. Compare the prior snapshot and explain denominator changes. Board Done alone is not completion evidence. If any source is unavailable, leave the previous verified snapshot intact, report STALE with cause and next retry time, and refresh automatically once capacity returns; never silently reuse an old percentage after a successful full read.

Every 15 minutes while active, compare actual workers with board owners and completion reports. Correct missing transitions and stale owner claims, then refill idle lanes. Complete roadmap refresh at 30 minutes is queue maintenance, not an acceptance gate. The external monitor reports drift to this coordinator; it never becomes another board writer.

## Stall recovery

| Observation | Action |
| --- | --- |
| Ambiguous send/start | Inspect original receipt/session/dispatch; never duplicate launch |
| Worker awaiting ordinary scope answer | Answer immediately; escalate unresolved product choices once |
| No useful progress for 15 minutes | Inspect edits/session; ask one bounded status question if unclear |
| Estimate reached or 30-minute checkpoint | Record completed/remaining scope and cause; adjust estimate or narrow within this issue |
| Productive worker exceeds estimate | Continue; time alone never terminates a worker |
| Provider concurrency or capacity response | Retry the same terminal several times at about 20-second spacing; do not relaunch, settle or reclassify it as a permission denial |
| Repeatedly confirmed capacity failure or quota refusal | Preserve work, settle/stop old attempt through Orca, reassign the same issue to another workhorse or offered fallback and update metadata |
| Antigravity sign-in banner with `agentWait: None` | Treat the session as ready; do not relaunch, reassign or report a blocker |
| OpenCode TinyCC/OpenTUI initialization failure | Re-apply the Windows ARM64 architecture fix and relaunch that terminal |
| Reviewer finds defects | Reviewer fixes and re-reviews itself; no implementer ping-pong |
| Conflicting editors/stale main | Establish exclusive ownership; reviewer resolves and re-reviews candidate |
| Real permission/repository rejection | Name exact rule/action and supported resolution; no unchanged retry loop or bypass |
| No eligible work in queue | Report every active/blocking leaf and accountable action; do not claim completion while any required work remains |

When externally blocked, persist the resume condition and let the scheduled monitor inspect for changes. Do not burn tokens polling unchanged state or leave an idle worker presented as active. Retain the candidate and release settled workers. Keep every other Ready issue moving and resume the blocked issue after its condition changes. There is no promise of uninterrupted progress through genuine external blocks.

## Orca lifecycle and cleanup

Use the currently installed Orca executable and its version-matched skills, resolving its path from the runtime rather than a fixed user installation path. Bind one coordinator run. Use supported worker/task/dispatch lifecycle and exact recovery receipts. Native agent chat is not a shell terminal; do not inject agent prompts into a shell merely because its handle appears on a run.

For supervised work use the installed orchestration guide's worker-start operation. Where its documented expressiveness requires an agent-first worktree launch, worktree create --agent uses Orca's configured launcher; terminal create --command supplies a custom command and does not establish that configured launcher options were applied. Inspect the actual launch/session before recording model, effort or permission mode. There is no documented hot-change of an existing child's permission mode. Do not restart a child or change settings to evade a rejected action. Settle and preserve a failed attempt before any otherwise permitted replacement; verify actual start, not merely accepted input.

Use isolated issue worktrees from origin/main. When a coordinator recovery inventory exists, inspect its preserved candidates and import only source changes applicable to the current issue. Archived instructions are historical evidence, never current policy. Reuse applicable preserved candidates; do not rebuild completed work, revive retired sessions or merge old branches wholesale. One editor per issue worktree at a time. Settle/release implementer before reviewer edits. Reviewer completion is consumed once; reconcile state, release reviewer and close its terminal.

Every merged-and-closed issue enters a cleanup-pending ledger immediately, independent of board API availability. At each completion and coordinator resume, compare `orca worktree list/ps` with `git worktree list --porcelain`; neither inventory alone is complete. For each exact candidate path, confirm its reviewer and implementer are settled, no live agent or terminal is editing, the PR is merged and issue closed, tracked and untracked files are accounted for, and no commit or useful note exists only in that worktree. Git-clean alone is insufficient. Close/release its idle Orca terminals, remove the registered worktree through Orca, then verify it is absent from both Orca and Git inventories. If Orca has already forgotten a Git-registered worktree, resolve that registry mismatch and remove only the verified exact orphan through Git's worktree operation. Never recursively delete by path or remove the primary checkout; never alter local/remote main as cleanup. Retain uncertain or unique work with owner, reason and next action. Clear the cleanup entry only after both inventories confirm removal. Diagnose a failed removal and retry that exact safe candidate; do not leave completed workspaces indefinitely labelled In progress.

## Implementer brief

```text
Issue #<n>; phase <n>; pickup <n>.
Read agent-coordination.md, full issue/comments, linked spec and current source.
Outcome: <plain functionality>. Already built: <source facts>.
Build: <bounded change and owning paths>. Exclude: <non-goals>.
Dependencies: <completed prerequisites>. Acceptance: <inspectable code behavior>.
Actual model/effort, estimate, worktree/branch, task/dispatch: <values>.
Implement this issue, commit/push candidate, then stop editing.
No tests or test edits, builds/typechecks/lint, DB execution/review,
hosted verification, Kestra or deployment. Do not change permissions or protections.
Report functionality, candidate commit/PR, acceptance mapping and limitations.
Request Opus 5.5/Sol review handoff. No issue closure, merge or shared board edits.
```

## Reviewer brief and completion

```text
You are the independent Opus 5.5 / GPT5.6 Sol review-and-fix owner of #<issue>.
Candidate/worktree/branch: <actual>. Issue/spec: <links>. Implementer settled.
Review the entire change and affected callers against bounded acceptance.
Fix findings yourself; commit and re-review the final candidate.
No tests or test edits, builds/typechecks/lint, DB/hosted reviews,
proof receipts, Kestra or deployment. Do not change permissions or protections.
Open the candidate PR if absent. Integrate reviewed PR into main through permitted repository operations.
If blocked, report exact cause; do not close the issue or claim Done.
After merge, update assigned issue with implemented outcome/final review and close completed.
Do not modify project fields or unrelated issues. Send once to orchestrator:
  Issue/phase/pickup; PR; reviewed commit; merge commit; issue closure state.
  Functionality built; findings fixed and re-reviewed; remaining limitations.
  Please update board, unblock dependents, roll up parents, release my session,
  clean the safe completed worktree, recompute the eligible queue across phases,
  and refill every open implementation and review lane.
Stop editing and idle for release; use Orca's exact completion contract.
```

## Checkpoint and reports

The coordinator owns a durable checkpoint outside disposable worktrees. Discover the existing coordinator-state root from runtime configuration; if none exists, create one under the current Orca home and record its resolved path. Read `checkpoint.md` and the reconciliation journal on startup before dispatch, reconciling them against live state. Never delete them during worktree cleanup.

Keep actual UTC, coordinator/run/session, current phase, every running/reviewing leaf, worker/reviewer, candidate/worktree/branch, reviewed/merged commits, status, progress time, estimates, blocker/resume condition, pending board writes, cleanup-pending and deliberately retained worktrees, last complete progress snapshot, and the next eligible queue in one checkpoint. It records facts, not new policy. Replace settled worker and obsolete API-capacity claims at each transition.

Every scheduled check reports findings even unchanged: a list of currently running tasks with actual agent/model/stage/elapsed estimate; tasks completed since the previous scheduled run; reviewed versus merged work; issue/board accuracy; blockers/actions; open lane count and why any lane is idle; next eligible issues across the queue; provider usage freshness; verified task-count progress percentages for the overall roadmap and the Phase 1-6 milestone; and progress toward the visible definition-led Phase 6 outcome. Never infer a percentage from a partial board page or say work is moving while idle.
