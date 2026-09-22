# Fleet operations

Read [agent coordination](agent-coordination.md) first. This procedure governs the GPT 5.6 Sol main orchestrator, implementers and Opus 5 / GPT 5.6 Sol reviewers. [Visual workflow](fleet-orchestration.html).

## Strict pickup algorithm

1. On startup/resume, inspect current coordinator/run, workers and worktrees. Adopt ownership only through supported Orca operations. Never duplicate a live or uncertain worker. Reconcile unfinished reports/status writes before selecting work.
2. Read all pages of GitHub Project 2 roadmap: required leaves, phase, numeric Pickup Order, status, native blockers and parent relationships. Cache this queue for the cycle. Refresh active/next items at each transition and the complete queue every 30 minutes or after a roadmap change. A partial view cannot establish an empty/completed phase.
3. Find the earliest phase with an unfinished required leaf. Exclude rollup parents and explicitly cancelled leaves. Reviewed but unmerged is unfinished.
4. Select that phase's smallest unfinished numeric Pickup Order. Do not skip it for cost, convenience, unavailable models, missing credentials, dependencies or a blocked merge. Finish an already active issue before selecting another. Do not jump phases.
5. Confirm the selected leaf's real native blockers and required children are complete. Correct stale dependency descriptions against source/spec with a recorded reason. Never delete a real dependency merely to make the task Ready.
6. A missing/duplicate Pickup Order, dependency cycle or real forward dependency is a planning blocker. Prepare the exact correction and ask the user before changing agreed order. Do not silently renumber or sort by issue number.
7. Read current source and bound remaining work. Already implemented functionality goes to a bounded Opus/Sol source review and completion reconciliation, not reimplementation. Otherwise select routing/estimate and dispatch the implementer.
8. After reviewed integration, issue closure, board reconciliation and cleanup, repeat. Advance phase only after all required leaves in this phase are complete. Phase 6 means implemented definition-led UI, not deployment or hosted evidence.

Strict order may reveal an external blocker. Resolve it or name the exact action needed; do not hide it by dispatching a later pickup. Provider changes and revised estimates never change Pickup Order. Do not go silently idle or claim an empty queue while ordered work remains.

## Models and capacity

| Work | Preferred model |
| --- | --- |
| Main orchestrator | GPT 5.6 Sol (Codex - High) |
| Mechanical changes, explicit schemas/catalogues/adapters | GLM 5.3 Flash (OpenCode) |
| Bounded UI components, pages and wiring | Gemini 3.8 Flash (Antigravity - High) |
| Ordinary runtime/service implementation | Claude Sonnet 5 (High) |
| Complex architecture, authorization or transactions | Claude Opus 5 (High), or GPT 5.6 Sol when capacity favours it |
| Alternative bounded implementation | GPT 5.6 Terra/Luna when cheaper suitable lanes are unavailable |
| All final reviews, fixes and re-reviews | Opus 5 or GPT 5.6 Sol (High), separate session from implementer |

Choose the cheapest capable model. Before pickup, review handoff and each 30-minute active checkpoint, inspect Claude/Codex session and weekly usage, reset time, freshness and errors with Orca's account command. Unknown quota is not unlimited. The following percentages guide routing and do not permit skipping the current pickup. Avoid routine implementation below 25% weekly remaining; preserve 15% for essential coordination/review. No automatic credit purchases or resets. If both qualified reviewers are unavailable, remain In review with a capacity blocker; do not skip this pickup.

Verify actual model/effort in launch/session; planned labels are not execution facts. Discover installed provider identifiers rather than guessing. Reassignment updates planned agent, estimate, actual worktree display name, issue metadata and parent row together. Retain an existing branch name accurately when appropriate.

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

Issue closure and project writes are separate. Maintain one short reconciliation entry per event in C:/Users/vijay/orca/coordination/Abzum-Vortex/board-reconciliation.jsonl: issue, intended fields, source commit/PR, UTC and pending/done. Read back the affected issue/item after writing. On interruption, inspect current state and retry only missing authorized updates; do not duplicate comments or repeatedly reopen/close an issue. Mark transient failure board-sync-pending. Reconcile pending entries before the next pickup. Use a local note, not a new coordination database/service.

Every 15 minutes while active, compare actual workers with board owners and completion reports. Correct missing transitions and stale owner claims. Complete roadmap refresh at 30 minutes is queue maintenance, not an acceptance gate. The external monitor reports drift to this coordinator; it never becomes another board writer.

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
| No eligible ordered work | Report first blocker and accountable action; do not dispatch higher pickup |

When externally blocked, persist the resume condition and let the scheduled monitor inspect for changes. Do not burn tokens polling unchanged state or leave an idle worker presented as active. Retain the candidate and release settled workers. Progress resumes at the same pickup after the condition changes. There is no promise of uninterrupted progress through genuine external blocks.

## Orca lifecycle and cleanup

Use C:/Users/vijay/AppData/Local/Programs/orca/resources/bin/orca.exe and its version-matched skills. Bind one coordinator run. Use supported worker/task/dispatch lifecycle and exact recovery receipts. Native Codex Chat is not a shell terminal; do not inject agent prompts into a shell merely because its handle appears on a run.

For supervised work use the installed orchestration guide's worker-start operation. Where its documented expressiveness requires an agent-first worktree launch, worktree create --agent uses Orca's configured launcher; terminal create --command supplies a custom command and does not establish that configured launcher options were applied. Inspect the actual launch/session before recording model, effort or permission mode. There is no documented hot-change of an existing child's permission mode. Do not restart a child or change settings to evade a rejected action. Settle and preserve a failed attempt before any otherwise permitted replacement; verify actual start, not merely accepted input.

Use isolated issue worktrees from origin/main. Reuse applicable preserved candidates; do not rebuild completed work or revive retired sessions. One editor at a time. Settle/release implementer before reviewer edits. Reviewer completion is consumed once; reconcile state, release reviewer and close its terminal.

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
  clean the safe completed worktree and proceed to the next ordered task.
Stop editing and idle for release; use Orca's exact completion contract.
```

## Checkpoint and reports

The coordinator owns C:/Users/vijay/orca/coordination/Abzum-Vortex/checkpoint.md outside disposable worktrees. Create the directory if absent; read this checkpoint and the reconciliation journal on startup before dispatch, reconciling them against live state. Never delete them during worktree cleanup.

Keep actual UTC, coordinator/run/session, phase/pickup/issue, worker/reviewer, candidate/worktree/branch, reviewed/merged commits, status, progress time, estimates, blocker/resume condition, pending board writes, retained worktrees and next ordered action in one checkpoint. It records facts, not new policy.

Every scheduled check reports findings even unchanged: actual activity, reviewed versus merged work, issue/board accuracy, blockers/actions, next pickup/phase, usage freshness and progress toward Phase 6. Never invent completion percentages or say work is moving while idle.
