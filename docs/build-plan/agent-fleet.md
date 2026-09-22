# Fleet operations

Read [agent coordination](agent-coordination.md) first. This procedure governs the GPT 5.6 Sol main orchestrator, implementers and Opus 5 / GPT 5.6 Sol reviewers. [Visual workflow](fleet-orchestration.html).

## Strict pickup algorithm

1. On startup/resume, inspect current coordinator/run, workers and worktrees. Adopt ownership only through supported Orca operations. Never duplicate a live or uncertain worker. Reconcile ownership ambiguity before dispatching the affected issue. Pending reports or status writes for one issue remain in the reconciliation journal and do not stop independent eligible work.
2. Read all pages of the configured authoritative roadmap project: required leaves, phase, numeric Pickup Order, status, native blockers and parent relationships. The concrete repository and project identifiers belong in coordinator runtime state, not this policy. Cache the queue for the cycle. Refresh active/next items at each transition and the complete queue every 30 minutes or after a roadmap change. A partial view cannot establish an empty/completed phase.
3. Find the earliest phase with unfinished required leaves. Exclude rollup parents and explicitly cancelled leaves. Reviewed but unmerged is unfinished. This phase is the only phase eligible for implementation dispatch.
4. Scan that phase's leaves in ascending numeric Pickup Order. Keep active work in place, then dispatch each dependency-ready, independently bounded leaf whose owning paths do not overlap an active editor until the lane target is full. Do not renumber or jump phases. A blocked or active lower pickup remains first in reporting, but it does not block a higher independent leaf in the same phase. A higher leaf that depends directly or indirectly on unfinished lower work is not eligible.
5. Confirm the selected leaf's real native blockers and required children are complete. Correct stale dependency descriptions against source/spec with a recorded reason. Never delete a real dependency merely to make the task Ready.
6. A missing/duplicate Pickup Order, dependency cycle or real forward dependency is a planning blocker. Prepare the exact correction and ask the user before changing agreed order. Do not silently renumber or sort by issue number.
7. Read current source and bound remaining work for enough eligible leaves to maintain six active implementer lanes by default, or eight when isolation and capacity are clear. Already implemented functionality goes to a bounded Opus/Sol source review and completion reconciliation, not reimplementation. Otherwise select routing/estimate and dispatch the implementer.
8. Treat implementer and reviewer capacity as separate pools. Up to four independent Opus 5 or GPT 5.6 Sol review-and-fix sessions may run concurrently. A candidate waiting for review, repository status, or integration does not consume an implementer lane and does not pause independent work in the same phase.
9. After any candidate handoff, reviewed integration, issue closure, board reconciliation or cleanup, immediately recompute eligibility and refill open lanes. Advance phase only after all required leaves in this phase are complete. Phase 6 means implemented definition-led UI, not deployment or hosted evidence.

Strict order is preserved by phase, dependencies and ascending dispatch, not by serializing unrelated work. Resolve external blockers or name the exact action needed; keep other independent leaves in the same phase moving. Provider changes and revised estimates never change Pickup Order. Do not go silently idle or claim an empty queue while eligible work or an unfilled lane remains.

## Models and capacity

| Work | Preferred model |
| --- | --- |
| Main orchestrator | GPT 5.6 Sol (Codex - High) |
| Mechanical changes, explicit schemas/catalogues/adapters | GLM 5.3 Flash (OpenCode) |
| Bounded UI components, pages and wiring | Gemini 3.8 Flash (Antigravity - Max) |
| Ordinary runtime/service implementation | Claude Sonnet 5 (High) |
| Complex architecture, authorization or transactions | Claude Opus 5 (High), or GPT 5.6 Sol when capacity favours it |
| Alternative bounded implementation | GPT 5.6 Terra, or GPT 5.6 Luna High for clearly defined bounded work |
| All final reviews, fixes and re-reviews | Opus 5 or GPT 5.6 Sol (High), separate session from implementer |

Choose the cheapest capable model. Before pickup, review handoff and each 30-minute active checkpoint, read `orca account list --json` for Claude and Codex session and weekly usage, reset times, freshness and errors. GLM and Antigravity capacity may require observing the actual provider response. Unknown quota is not unlimited. The following percentages guide routing and do not permit skipping the current pickup. Avoid routine implementation below 25% weekly remaining; preserve 15% for essential coordination/review. No automatic credit purchases or resets, and do not repeatedly probe a provider that has already returned a limit. If both qualified reviewers are unavailable, remain In review with a capacity blocker; do not substitute a cheaper reviewer, claim Done or skip this pickup.

For implementation waves, distribute work across qualified providers instead of filling every lane with one provider. Prefer GLM for mechanical contract/catalogue work, Gemini 3.8 Flash Max for bounded UI and wiring, Sonnet 5 High for ordinary runtime/service work, Terra for bounded general implementation, and Luna High only when the task is clearly defined and bounded. Unknown usage telemetry is not proof that an installed provider cannot execute; use a single bounded launch to establish availability when that model is the best fit, then record the actual result. Avoid assigning more than half of active implementer lanes to one provider when equally suitable alternatives are available. Opus 5 and GPT 5.6 Sol are reserved for review, complex decisions and orchestration.

Verify actual model/effort in launch/session; planned labels are not execution facts. Resolve provider and model identifiers from the current Orca runtime configuration at dispatch, confirm the actual session identity, and record it in the checkpoint. Never label another version as the requested model. Reassignment updates planned agent, estimate, actual worktree display name, issue metadata and parent row together. Retain an existing branch name accurately when appropriate.

## Metadata

Each leaf title starts #<issue>. Include phase label, numerical pickup, plain Summary, Already built, What will be built, scope boundaries, functional acceptance, specification references, Blocked by and Blocks. No test instructions or proof checklists.

Record planned implementer, reviewer, active-minute implementation/review estimates, actual worktree/branch, current owner, task/dispatch/session, UTC start/finish, last useful progress, PR/reviewed/merged commits and blocker. Worktree display name: #<issue> - <agent>. Default new branch: codex/<issue>-<agent-slug>; always record the branch actually created. Parent estimates total children, not additional effort. Queued/blocked minutes are separate from active time.

## Board reconciliation

Orchestrator is the sole project-board writer. Reviewer is explicitly allowed to update/close its assigned issue and manage its PR. Update at every event:

| Event | Board action |
| --- | --- |
| Ordered issue eligible | Ready, planned model/estimate, no active owner yet |
| Actual worker start | In progress, actual model/dispatch/branch, UTC start |
| Implementation complete | In review, candidate commit, implementer cleared, reviewer queued/started |
| Reviewer starts/fixes | In review, actual reviewer, review/fix substate, current candidate |
| Blocker/provider failure/exit | Truthful stage, exact reason, owner, next action and resume condition; clear dead owner |
| Reassignment | Issue, parent row and board reflect new actual agent/estimate/worktree |
| Reviewer reports merged/closed | Orchestrator writes Done, merge/review references, finish time, no active owner, dependent eligibility refreshed |
| Cleanup/phase completion | Lifecycle outcome recorded, parent/phase rolled up from completed required leaves |

Issue closure and project writes are separate. Resolve the coordinator-state root from the current checkpoint/runtime configuration and maintain one short `board-reconciliation.jsonl` entry per event there: issue, intended fields, source commit/PR, UTC and pending/done. Read back the affected issue/item after writing. On interruption, inspect current state and retry only missing authorized updates; do not duplicate comments or repeatedly reopen/close an issue. Mark transient failure board-sync-pending. Pending writes for one issue do not stop independent eligible leaves; retain and retry them through the journal. Use a local note, not a new coordination database/service.

Every 15 minutes while active, compare actual workers with board owners and completion reports. Correct missing transitions and stale owner claims, then refill idle lanes. Complete roadmap refresh at 30 minutes is queue maintenance, not an acceptance gate. The external monitor reports drift to this coordinator; it never becomes another board writer.

## Stall recovery

| Observation | Action |
| --- | --- |
| Ambiguous send/start | Inspect original receipt/session/dispatch; never duplicate launch |
| Worker awaiting ordinary scope answer | Answer immediately; escalate unresolved product choices once |
| No useful progress for 15 minutes | Inspect edits/session; ask one bounded status question if unclear |
| Estimate reached or 30-minute checkpoint | Record completed/remaining scope and cause; adjust estimate or narrow within this issue |
| Productive worker exceeds estimate | Continue; time alone never terminates a worker |
| Confirmed provider failure/quota refusal | Preserve work, settle/stop old attempt through Orca, reassign same pickup and update metadata |
| Reviewer finds defects | Reviewer fixes and re-reviews itself; no implementer ping-pong |
| Conflicting editors/stale main | Establish exclusive ownership; reviewer resolves and re-reviews candidate |
| Real permission/repository rejection | Name exact rule/action and supported resolution; no unchanged retry loop or bypass |
| No eligible work in current phase | Report every active/blocking leaf and accountable action; do not jump to a later phase |

When externally blocked, persist the resume condition and let the scheduled monitor inspect for changes. Do not burn tokens polling unchanged state or leave an idle worker presented as active. Retain the candidate and release settled workers. Progress resumes at the same pickup after the condition changes. There is no promise of uninterrupted progress through genuine external blocks.

## Orca lifecycle and cleanup

Use the currently installed Orca executable and its version-matched skills, resolving its path from the runtime rather than a fixed user installation path. Bind one coordinator run. Use supported worker/task/dispatch lifecycle and exact recovery receipts. Native agent chat is not a shell terminal; do not inject agent prompts into a shell merely because its handle appears on a run.

For supervised work use the installed orchestration guide's worker-start operation. Where its documented expressiveness requires an agent-first worktree launch, worktree create --agent uses Orca's configured launcher; terminal create --command supplies a custom command and does not establish that configured launcher options were applied. Inspect the actual launch/session before recording model, effort or permission mode. There is no documented hot-change of an existing child's permission mode. Do not restart a child or change settings to evade a rejected action. Settle and preserve a failed attempt before any otherwise permitted replacement; verify actual start, not merely accepted input.

Use isolated issue worktrees from origin/main. When a coordinator recovery inventory exists, inspect its preserved candidates and import only source changes applicable to the current issue. Archived instructions are historical evidence, never current policy. Reuse applicable preserved candidates; do not rebuild completed work, revive retired sessions or merge old branches wholesale. One editor per issue worktree at a time. Settle/release implementer before reviewer edits. Reviewer completion is consumed once; reconcile state, release reviewer and close its terminal.

Before removing a completed worktree, confirm no live editor, no unmerged commit and no unique tracked/untracked files. Save useful notes first. Use Orca worktree removal on a verified exact path. Never delete the primary checkout or alter local/remote main as cleanup. Retain blocked candidates with a reason and owner. Diagnose cleanup failure instead of suppressing it.

## Implementer brief

```text
Issue #<n>; phase <n>; pickup <n>.
Read agent-coordination.md, full issue/comments, linked spec and current source.
Outcome: <plain functionality>. Already built: <source facts>.
Build: <bounded change and owning paths>. Exclude: <non-goals>.
Dependencies: <completed prerequisites>. Acceptance: <inspectable code behavior>.
Actual model/effort, estimate, worktree/branch, task/dispatch: <values>.
Implement this issue, commit/push candidate, then stop editing.
No tests, DB execution/review, hosted verification, Kestra or deployment.
Report functionality, candidate commit/PR, acceptance mapping and limitations.
Request Opus5/Sol review handoff. No issue closure, merge or shared board edits.
```

## Reviewer brief and completion

```text
You are the independent Opus5 / GPT5.6 Sol review-and-fix owner of #<issue>.
Candidate/worktree/branch: <actual>. Issue/spec: <links>. Implementer settled.
Review the entire change and affected callers against bounded acceptance.
Fix findings yourself; commit and re-review the final candidate.
No tests, DB/hosted reviews, proof receipts, Kestra or deployment.
Open the candidate PR if absent. Integrate reviewed PR into main through permitted repository operations.
If blocked, report exact cause; do not close the issue or claim Done.
After merge, update assigned issue with implemented outcome/final review and close completed.
Do not modify project fields or unrelated issues. Send once to orchestrator:
  Issue/phase/pickup; PR; reviewed commit; merge commit; issue closure state.
  Functionality built; findings fixed and re-reviewed; remaining limitations.
  Please update board, unblock dependents, roll up parents, release my session,
  clean the safe completed worktree, recompute the current-phase eligible queue,
  and refill every open implementation and review lane.
Stop editing and idle for release; use Orca's exact completion contract.
```

## Checkpoint and reports

The coordinator owns a durable checkpoint outside disposable worktrees. Discover the existing coordinator-state root from runtime configuration; if none exists, create one under the current Orca home and record its resolved path. Read `checkpoint.md` and the reconciliation journal on startup before dispatch, reconciling them against live state. Never delete them during worktree cleanup.

Keep actual UTC, coordinator/run/session, current phase, every running/reviewing leaf, worker/reviewer, candidate/worktree/branch, reviewed/merged commits, status, progress time, estimates, blocker/resume condition, pending board writes, retained worktrees and the next eligible queue in one checkpoint. It records facts, not new policy.

Every scheduled check reports findings even unchanged: a list of currently running tasks with actual agent/model/stage/elapsed estimate; tasks completed since the previous scheduled run; reviewed versus merged work; issue/board accuracy; blockers/actions; open lane count and why any lane is idle; next eligible pickups in the current phase; provider usage freshness; verified task-count progress percentages for the overall roadmap and the Phase 1-6 milestone; and progress toward the visible definition-led Phase 6 outcome. Never infer a percentage from a partial board page or say work is moving while idle.
