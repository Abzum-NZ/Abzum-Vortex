# Fleet operations

Read [agent coordination](agent-coordination.md) first. This procedure governs the main orchestrator (one session of Claude Opus 5.5 or GPT-6 Sol), implementers and Opus 5.5 / GPT-6 Sol reviewers. [Visual workflow](fleet-orchestration.html).

## Ready-work dispatch algorithm

1. On startup/resume, inspect current coordinator/run, workers and worktrees. Adopt ownership only through supported Orca operations. Never duplicate a live or uncertain worker. Reconcile ownership ambiguity before dispatching the affected issue. Pending reports or status writes for one issue remain in the reconciliation journal and do not stop independent eligible work.
2. Read all pages of the configured authoritative roadmap project: required leaves, phase, status, native blockers, parent relationships and Pickup Order metadata. The concrete repository and project identifiers belong in coordinator runtime state, not this policy. Cache the queue for the cycle. Refresh active/next items at each transition and the complete queue every 30 minutes or after a roadmap change. A partial view cannot establish an empty queue or completed required leaves.
3. Scan every non-rollup, non-cancelled leaf across all phases. Reviewed but unmerged is unfinished. Phase and Pickup Order are planning and reporting metadata, not dispatch gates; implementation eligibility is governed by actual dependencies, bounded scope, exclusive owning paths and available capacity.
4. Keep active work in place, then dispatch every dependency-ready, independently bounded leaf whose owning paths do not overlap an active editor until the lane target is full. Phase never limits that selection; prefer lower Pickup Order only to break ties between equally ready leaves. A leaf is ineligible only because of a real dependency, overlapping ownership, unresolved scope or unavailable capacity.
5. Confirm the selected leaf's real native blockers and required children are complete. Correct stale dependency descriptions against source/spec with a recorded reason. Never delete a real dependency merely to make the task Ready.
6. A dependency cycle or contradictory native dependency is a planning blocker. Pickup Order may remain missing, duplicated or out of sequence because it is reporting metadata; never wait for or renumber it before dispatching Ready work.
7. Read current source and bound remaining work for enough eligible leaves to maintain eight active implementer lanes by default, or up to twelve when isolation and capacity are clear. Already implemented functionality goes to a bounded Opus/Sol source review and completion reconciliation, not reimplementation. Otherwise select routing/estimate and dispatch the implementer.
8. Treat implementer and reviewer capacity as separate pools. Up to six independent Opus 5.5 or GPT-6 Sol review-and-fix sessions may run concurrently, spread across both providers. Start a reviewer for every handed-off candidate in the same cycle; when the review queue exceeds free review lanes, fill review lanes before opening new implementer lanes. A candidate waiting for repository status or integration does not consume an implementer lane and does not pause independent work elsewhere in the queue.
9. After any candidate handoff, reviewed integration, issue closure, board reconciliation or cleanup, immediately recompute eligibility and refill open lanes. Phase 6 means implemented definition-led UI, not deployment or hosted evidence; phase completion is a reporting rollup, not a dispatch gate.

Phase labels and Pickup Order are preserved as planning/reporting metadata, while real dependencies, bounded scope, exclusive ownership and capacity determine readiness. Resolve external blockers or name the exact action needed; keep every independent Ready leaf across the queue moving. Provider changes and revised estimates never change readiness. Do not go silently idle or claim an empty queue while eligible work or an unfilled lane remains.

## Models and capacity

| Work | Preferred model |
| --- | --- |
| Main orchestrator | One session of Claude Opus 5.5 (High) or GPT-6 Sol (Codex - High) |
| Bounded implementation, schemas, catalogues, adapters and services | GPT-6 Luna (Codex - High), DeepSeek 4.1 Flash (`deepseek/deepseek-flash`, OpenCode) or GLM 5.3 Flash (OpenCode) |
| Bounded UI components, pages and wiring | Gemini 3.8 Flash (Antigravity - Max or High) or GPT-6 Luna (Codex - High) |
| Alternative implementation | Claude Sonnet 5 (High) |
| Complex architecture, authorization or transactions | Claude Opus 5.5 (High) or GPT-6 Sol (High), whichever has capacity |
| All final reviews, fixes and re-reviews | Claude Opus 5.5 (High) or GPT-6 Sol (High), separate session from implementer, spread across both |

Choose the cheapest capable model. Before dispatch, review handoff and each 30-minute active checkpoint, read `orca account list --json` for Claude and Codex session and weekly usage, reset times, freshness and errors. GLM and Antigravity capacity may require observing the actual provider response. Unknown quota is not unlimited. Capacity guidance does not permit ignoring real dependencies, unresolved scope or exclusive ownership. Avoid routine implementation below 25% weekly remaining; preserve 15% for essential coordination/review. No automatic credit purchases or resets. If both qualified reviewers are unavailable, remain In review with a capacity blocker; do not substitute a cheaper reviewer or claim Done.

Treat a provider concurrency, rate-limit or model-unavailable response as a capacity result, not a tool-approval denial. One capacity response does not settle the attempt: retry the same terminal several times at about 20-second spacing and record each actual provider response. Only after repeated confirmed capacity failures preserve the branch/worktree, settle that attempt and move implementation to the next cheapest suitable authorized workhorse or an offered fallback, without waiting for user direction. Real permission and repository-protection denials remain non-bypassable: do not retry unchanged, change controls or route through another executor to evade them.

For implementation waves, distribute work across qualified providers instead of filling every lane with one provider. Primary workhorses are GPT-6 Luna, DeepSeek 4.1 Flash, GLM 5.3 Flash and Gemini 3.8 Flash Max or High. Use only `deepseek/deepseek-flash` for DeepSeek, never DeepSeek Pro. GLM handles suitable mechanical work when capacity is available; persistent GLM concurrency failures route the same preserved leaf to DeepSeek Flash or GPT-6 Luna. Claude Sonnet 5 High is an alternative. Unknown usage telemetry is not proof that an installed provider cannot execute; use a real bounded launch to establish availability when that model is the best fit, then record the actual result. No provider holds more than half of active implementer lanes when equally suitable alternatives are available. Opus 5.5 and GPT-6 Sol are reserved for review, complex decisions and orchestration, and reviews are spread across both.

Verify actual model/effort in launch/session; planned labels are not execution facts. Resolve provider and model identifiers from the current Orca runtime configuration at dispatch, confirm the actual session identity, and record it in the checkpoint. Never label another version as the requested model. Reassignment updates planned agent, estimate, actual worktree display name, issue metadata and parent row together. Retain an existing branch name accurately when appropriate.

## Workhorse terminal launch

Launch each provider through its normal supported path and judge readiness by actual session state rather than cosmetic output.

| Provider | Normal launch | Readiness and recovery |
| --- | --- | --- |
| Antigravity Gemini 3.8 Flash | `agy-trusted.cmd` | Ready when the session reports `agentWait: None`. The sign-in banner is cosmetic; it is not a blocker, a capacity result or a permission denial. |
| OpenCode DeepSeek 4.1 Flash or GLM 5.3 Flash | `opencode` | Orca headless `opencode run` uses the native ARM64 build; interactive screen uses x64. Confirm the actual selected model and turn start. TinyCC/OpenTUI failure, segfault or silent headless exit is an architecture failure, not capacity or permissions. |

A GLM concurrency-capacity response is a capacity result on an otherwise healthy terminal: retry the same worker several times at about 20-second spacing rather than relaunching it or reclassifying it as a permission problem. After repeated confirmed capacity failures, preserve work, settle the old owner and reassign the leaf to DeepSeek Flash when suitable. If an OpenCode architecture failure occurs, first settle and preserve every active OpenCode worker: `C:\Users\vijay\.orca\bin\opencode-fix-arch.cmd` stops all OpenCode processes. Only then run that fix once. Relaunch or reassign every interrupted preserved OpenCode leaf, verify actual starts and reconcile owner/session/board metadata; retry the triggering leaf as part of that recovery. Do not use historical Herdr instructions.

## Metadata

Each leaf title starts #<issue>. Include phase label, numerical pickup, plain Summary, Already built, What will be built, scope boundaries, functional acceptance, specification references, Blocked by and Blocks. No test instructions or proof checklists.

Record planned implementer, reviewer, active-minute implementation/review estimates, actual worktree/branch, current owner, task/dispatch/session, UTC start/finish, last useful progress, PR/reviewed/merged commits and blocker. Worktree display name: #<issue> - <agent>. Default new branch: codex/<issue>-<agent-slug>; always record the branch actually created. Parent estimates total children, not additional effort. Queued/blocked minutes are separate from active time.

## Board reconciliation

Orchestrator owns shared board state. An implementer or reviewer writes only its own assigned issue's row at its own transitions (see the no-choke-point rules); a reviewer also updates and closes its assigned issue and manages its PR. Update at every event:

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

Before each scheduled progress report, use the latest shared complete paginated Project and native-relationship snapshot, plus all verified targeted event deltas since its source time, to refresh `monitor-progress.json`. The coordinator schedules one complete refresh within each reporting interval and after a structural roadmap change; the monitor does not duplicate it. Exclude rollup parents, phase epics, cancelled/duplicate/not-planned leaves and administrative PRs. Count a leaf only with review, main-merge, issue-closure and board-readback evidence. Write the counts and percentages for the full roadmap and Phases 1–6 atomically with complete-snapshot and delta timestamps; explain denominator changes. Board Done alone is not completion evidence. If a required source is unavailable or the complete snapshot has aged beyond the reporting interval, leave the previous verified snapshot intact, report STALE with cause and next retry time, and refresh automatically once capacity returns; never silently reuse an old percentage after a successful full read.

### GitHub Project API budget

Project 2 mutations and reads use the same GraphQL point budget across the coordinator, monitor and manual scripts. Treat the `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers from an actual GraphQL response, plus its `errors` array, as authoritative. `gh api rate_limit` may show a cached GraphQL bucket that disagrees with the live response. Any unexpected nonempty GraphQL `errors` array fails that operation or page even with HTTP 200 or partial `data`; primary exhaustion may appear as `RATE_LIMITED`, another rate-limit type, or an API-rate-limit message and zero remaining points. Record remaining points, observed UTC, reset time and the attempted operation in the reconciliation journal. On exhaustion, retain pending writes with their exact intended values and make the first retry only after the reset; keep them pending with bounded backoff if that retry also fails. Do not poll or repeatedly fetch full Project pages before then. Recheck fresh headers after the reset because the reported reset may change.

The orchestrator is the sole Project fetch-and-write owner for one reconciliation cycle. A monitor reads the coordinator's complete timestamped Project snapshot and targeted board readbacks; it does not start another full pagination while that snapshot is current or the coordinator is fetching it. Share one complete result between readiness, board audit and progress calculation. Run it on coordinator startup, a structural roadmap change, and a scheduled snapshot cycle no more often than the monitor reporting cadence. Never rerun the full audit after each single-field repair; inspect the touched item instead. Refresh the full snapshot again when capacity permits if the complete source is older than its reporting interval. A transient unavailable source makes the percentage explicitly STALE with cause and retry time; it does not make a partially fetched board current.

Split complete refreshes into a slim paginated Project inventory (item ID, issue number/state/updatedAt and required board fields) and a separate native-relationship pass. Do not nest wide `fieldValues`, `subIssues`, `blockedBy` and `blocking` connections beneath every Project item: connection cost multiplies across pages even when results are sparse and can exhaust the hourly budget after a few refreshes. Issue `updatedAt` changes invalidate that issue's cached relationships; fetch those and uncached open issues immediately for readiness. Also sweep every required leaf's native relationships separately at least once per reporting interval, because a relationship change made outside the coordinator might not change the expected issue timestamp. A snapshot cannot be called complete once any relationship entry exceeds that interval; label the percentage STALE until the sweep succeeds. Keep page cursors and source times; atomically publish the snapshot only after every required page and relationship is present. A targeted event readback does not require a whole-project refresh.

Keep a local cache of verified issue-to-Project-item IDs, field IDs, option IDs and last readback values. For each worker start, handoff, review, merge or closure, coalesce queued changes for that issue and compare with the last verified row. Write only changed fields. Give Status and Current owner priority over descriptive fields so the visible board reflects the real stage promptly. Batch a bounded group of changed-field mutations through one GraphQL request using aliases/variables; inspect every mutation result and GraphQL error. Include the touched item's fields in the final mutation response when supported, or make one targeted readback after the batch. Mark only confirmed fields done in `board-reconciliation.jsonl`; retain any partial write. Update dependent and parent rows from the same event without re-reading all Project items. This reduces requests and redundant writes without skipping a required board field.

Before a complete scan, query the live GraphQL budget and reserve at least one fifth of the current hourly limit for new board transitions. If the scan would consume the reserve, defer that scan, keep processing essential targeted updates, and report the complete snapshot's timestamp. At reset, drain pending event changes first, then take one complete snapshot, audit it and atomically update `monitor-progress.json`. Space mutation requests to respect GitHub's secondary limits; on a secondary limit or transient server error, honor `Retry-After` if supplied, otherwise back off exponentially instead of creating a retry storm. Never let a report or audit loop consume the points needed to keep live statuses current. If other API clients exhaust the shared bucket despite this budget, record the concrete external capacity block; no system can write a GitHub board while GitHub rejects its API.

Every 15 minutes while active, compare actual workers with board owners and completion reports using targeted readbacks. Correct missing transitions and stale owner claims, then refill idle lanes. A shared complete roadmap refresh runs within the scheduled reporting interval and when its topology changes; it is queue maintenance, not an acceptance gate. The external monitor consumes that shared snapshot and reports drift to this coordinator; it never becomes another board writer or duplicate full-scan client.

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
| OpenCode TinyCC/OpenTUI, segfault or silent headless exit | Settle/preserve all active OpenCode workers before the one ARM64 repair, which stops all OpenCode processes; then relaunch/reassign every interrupted leaf, verify starts and reconcile ownership |
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
Set your own issue row to In review, then request Opus 5.5/GPT-6 Sol review handoff.
No issue closure, merge, or edits to any other board row.
```

## Reviewer brief and completion

```text
You are the independent Opus 5.5 / GPT-6 Sol review-and-fix owner of #<issue>.
Candidate/worktree/branch: <actual>. Issue/spec: <links>. Implementer settled.
First read the complete live GitHub issue, every comment and linked spec.
Then review the entire candidate change, current main and affected callers against bounded acceptance.
Fix findings yourself; commit and re-review the final candidate.
No tests or test edits, builds/typechecks/lint, DB/hosted reviews,
proof receipts, Kestra or deployment. Do not change permissions or protections.
Open the candidate PR if absent. Integrate reviewed PR into main through permitted repository operations.
If blocked, report exact cause; do not close the issue or claim Done.
After merge, update assigned issue with implemented outcome/final review and close completed.
After closure, set your own issue row to Done, clear Current owner and record the finish time.
Do not modify other project rows or unrelated issues. Send once to orchestrator:
  Issue/phase/pickup; PR; final reviewed commit; merge commit; verified issue closure.
  Functionality built; findings fixed and re-reviewed; remaining limitations.
  Please verify these facts, reconcile shared board state, unblock dependents, roll up parents, release both settled agents,
  clean the safe completed worktree, recompute the eligible queue across phases,
  and refill every open implementation and review lane.
Stop editing and idle for release; use Orca's exact completion contract.
```

## Checkpoint and reports

The coordinator owns a durable checkpoint outside disposable worktrees. Discover the existing coordinator-state root from runtime configuration; if none exists, create one under the current Orca home and record its resolved path. Read `checkpoint.md` and the reconciliation journal on startup before dispatch, reconciling them against live state. Never delete them during worktree cleanup.

Keep actual UTC, coordinator/run/session, current phase, every running/reviewing leaf, worker/reviewer, candidate/worktree/branch, reviewed/merged commits, status, progress time, estimates, blocker/resume condition, pending board writes, cleanup-pending and deliberately retained worktrees, last complete progress snapshot, and the next eligible queue in one checkpoint. It records facts, not new policy. Replace settled worker and obsolete API-capacity claims at each transition.

Every scheduled check reports findings even unchanged: a list of currently running tasks with actual agent/model/stage/elapsed estimate; tasks completed since the previous scheduled run; reviewed versus merged work; issue/board accuracy; blockers/actions; open lane count and why any lane is idle; next eligible issues across the queue; provider usage freshness; verified task-count progress percentages for the overall roadmap and the Phase 1-6 milestone; and progress toward the visible definition-led Phase 6 outcome. Never infer a percentage from a partial board page or say work is moving while idle.
