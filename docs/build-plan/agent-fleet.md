# Fleet operations

Read [agent coordination](agent-coordination.md) first: it sets the current Codex Desktop control plane, roles, capacity, lifecycle and verification. This file gives the procedure. The lead coordinates native Codex subagents first, then useful bounded workers from the owner-authorized Orca Luna Extra High, Antigravity Gemini 3.8 Flash, OpenCode Kimi K3 and OpenCode Space Bunny pool when their normal controls and actual runtime permit. No separate coordinator, retired autonomous service, custom app-server or external scheduler is authorized. Deterministic local helpers may cache, journal or run requested checks, but cannot form a second coordinator.

The coordination root is `C:/Users/vijay/.codex/fleet/Abzum-Vortex`. Keep machine-specific checkout and process facts in the checkpoint, not in this policy.

## Resume and dispatch

1. **Resume.** Read the checkpoint and append-only journal. Reconcile native child status, actual processes, managed worktrees, open PR heads, Project state, locks and pending writes. Treat an uncertain worker as active until investigated; do not duplicate work because a session looks idle.
2. **Snapshot.** Refresh the slim, fully paginated roadmap Project snapshot at the active cadence in [Agent coordination](agent-coordination.md#board-continuity-and-rate-limits), after structural changes, and from event read-backs between snapshots. Refresh native relationships separately.
3. **Choose.** Keep a small verified pickup ledger of two or three shaped leaves. A leaf is eligible only when its current comments and native blockers agree, its premise holds in current source, its scope is bounded, its owning paths do not overlap an active editor, and capacity exists. Current-phase blockers and Pickup Order break ties. Never remove a real dependency to make an issue Ready.
4. **Actionable review first.** Give an unreviewed candidate priority when its handoff is complete and an independent Sol reviewer can make progress in an assigned managed worktree. Send a fully gated merge packet promptly to the lead. Preserve a PR blocked on external access, another owner or incomplete checks with an exact next action; its wait does not hold an otherwise verified, independent implementation leaf. Merge readiness does not permit a worker to merge; the lead makes the final decision.
5. **Fill only useful capacity.** Target five useful assignments when eligible work and observed capacity allow, normally three implementer/recovery workers, one independent Sol reviewer and one flexible ownership/shaping worker. More bounded workers may run when disjoint qualified work, independent review throughput and measured memory allow. Dispatch an idle implementer to a verified leaf in the same active turn. If none qualifies, shape the highest-value Backlog candidate and record the missing prerequisite. For a review backlog, prefer one implementer and two reviewers. Reserve a child for an independent phase walkthrough. Do not claim empty work or dispatch capacity from partial data.
6. **Shape and assign.** Follow [Shape before dispatch](agent-coordination.md#shape-before-dispatch). Existing implementation goes to independent review and reconciliation, not reimplementation. Assign a lead-owned isolated managed worktree, branch, issue and explicit owning paths before the child edits.
7. **Recompute.** After a handoff, merge, closure, board transition or blocker, refresh the affected evidence and reconsider eligible work in the same active turn. Preserve a blocked child's unique work, release its slot and continue independent leaves. Do not run an always-on poller.

Target five productive children using observed native capacity first, then verified workers from the owner-authorized pool. Five is not a fixed maximum. The native configuration excludes the primary; verify live capacity separately. Count actual active workers, not old completed threads, shell tabs, catalog entries or accepted startup requests. Record any shortfall and immediately qualify another bounded assignment when useful work exists. Do not keep an idle model polling for work. A child does not inherit a private checkout or durable background execution automatically. Native work may be interrupted by user input, app closure, context or shared usage limits. Preserve a recovery point and keep coordination claims honest.

## Worker handoffs

Every handoff records issue and outcome, complete dependencies, acceptance, scope boundaries, assigned worktree and branch, migration reservation if any, actual model and reasoning effort, and the exact requested deliverable. Use the issue's complete context, not an abbreviated summary. Workers report evidence and blockers to the lead.

- **Read-only inventory or summary:** Luna, Extra High, or a verified owner-authorized provider when delegation saves work; supply exact sources and questions. Require source evidence for claims and keep it bounded.
- **Implementation:** Luna, Extra High, or a verified owner-authorized external worker for one bounded outcome. The lead assigns the managed worktree and checks ownership and path boundaries. The implementer validates definitions when needed, commits, and returns the complete self-review packet, candidate SHA, changed paths, acceptance mapping, validator result, limitations, and whether a PR was opened. An external implementer's self-review never replaces independent Sol review.
- **Review and fix:** fresh Sol, High for ordinary bounded review; Extra High for privilege, authentication, SQL ownership, tenant boundaries, transactions, architecture or unresolved cross-layer failures. Use a separate session and worktree after the implementer stops. The reviewer reads the live issue and all comments, specification, complete diff, current main and affected callers; fixes findings; re-reads changed context; re-reviews; and returns the exact-head verdict, checks and limitations to the lead. It never merges. Reuse the same independent reviewer for later acceptance of its candidate when appropriate.
- **Planning:** Sol, High or Extra High for bounded architecture options and issue shaping. Astra, High is an exceptional consultation only for a named unresolved decision. External workers may supply bounded evidence, but product decisions remain with the owner or delegated decision-maker.
- **Independent monitor:** Sol, High when needed for preview evidence or phase acceptance. Keep it independent from implementation. It does not become a permanent service.

Reasoning is selected by risk. Keep Luna Extra High for implementation and corrections. For another provider, verify the connected model, advertised effort, successful start and actual runtime identity before assignment; a requested configuration is not proof. Sol High ordinary review is a measured pilot, while sensitive review stays Extra High; neither changes independence or verification. Record actual model and effort; do not infer them from the plan label. Compare rework and acceptance before changing routing further. Optimize cost per accepted change, not the number of simultaneous agents.

Before independent review, every implementer handoff names the full candidate and base SHAs, changed paths, acceptance-to-source mapping, focused final-diff and caller self-review, actual findings and corrections (or reviewed cases when none), edge cases, checks with exit codes, and pending limits. The lead returns an incomplete packet to the same implementer session; it does not invent evidence or spend a Sol slot on an incomplete handoff. See the [implementer template](#implementer-handoff-template).

## Branches, worktrees and migrations

- One issue has one editor and one lead-assigned isolated managed worktree at a time. Base new work on current `origin/main`. Create branches with `--no-track`; use the `codex/` branch prefix unless the owner or repository procedure says otherwise. A reviewer uses its own isolated managed worktree on the PR branch.
- Never push to main. Push only with the explicit refspec `git push origin HEAD:refs/heads/<branch>`. Verify that the branch has no upstream tracking `origin/main`. Main is protected, including for administrators.
- Before merge, the lead verifies the PR head, base and review are current. Update from `origin/main` when required, inspect merge changes, rerun checks invalidated by the new head, and re-read the candidate immediately before the protected merge. A changed head invalidates prior review or check evidence.
- When the exact-head review and all required check evidence are complete, the lead attempts the protected PR merge in that active turn. Optional preview/browser work must not queue an otherwise eligible merge. Classify a failed merge as changed head or base, missing evidence, conflict, protection or integration access; record one owner and next action. Never use another identity or executor to bypass a real 403.
- Before dispatching a migration, compute the next free number from current `origin/main` and reserve it in the checkpoint. Every child takes its number only from the lead. Renumber before merge if it sorts before an existing main migration.
- Preserve untracked, uncommitted, unpushed and otherwise unique work before considering worktree cleanup. Do not remove a worktree while a child or process uses it. Retain uncertain work with an owner, reason and next action. No recursive delete by computed path, no primary-checkout removal and no cleanup against main. Never blindly revert dependent migration or subsequent work.

## Verification concurrency

Vortex does not use a global persistent `heavy.lock` or `heavy.lock2` for verification. No agent or helper may create, check, wait on or restore either file as a prerequisite for typecheck, web build, disposable SQL replay, preview, browser verification or merge.

Scoped typecheck and web build may run in parallel in **different** worktrees. Do not concurrently run commands that write generated outputs in the same checkout. Disposable SQL replay creates a fresh `vortex-verify-*` container and network with a random host port; independent PR replays may run in parallel when measured Docker and memory capacity permit. Each run cleans only its own disposable resources and never resets the shared preview database. Measure free physical memory before a memory-intensive command and require at least 3 GB. When capacity is insufficient, record the PR, full head SHA, command, owner and next attempt; do not use a fleet-wide filesystem lock as the queue.

The shared local preview database and fixed web port are genuinely mutable shared resources. One independent owner controls their reset, setup and browser observation at a time. If a resource-scoped lease is used, it records owner/session, PR, exact SHA, resource, creation time, expiry and renewal during long runs, and recovers automatically after owner exit or expiry with process-identity checks. It cannot become a permanent fleet-wide gate. Checks on isolated worktrees and disposable databases continue while preview is occupied. A stale coordination artifact must never indefinitely block review.

The lead classifies each open PR by its next missing required exact-head gate: source review, applicable typecheck/build/SQL replay or definition checks, ready to merge, or another stated blocker. Track optional preview/browser evidence separately. Idle eligible verification capacity with a growing In review queue is a stall requiring same-turn assignment or a recorded concrete recovery. A new commit invalidates affected execution and optional preview/browser evidence. Exact-head review, applicable scoped checks and protected merge remain mandatory.

## Preview checks and browser smoke

The shared preview stack is local. The lead assigns one independent preview owner at a time; no concurrent database reset or setup operation is allowed. Capture the stack state and exact commit before each check.

For definitions, migrations or `apps/web/scripts/development-setup`, an independent exact-head preview may run when the safe stack is available: fresh `db reset` and `setup:local`. For pages, forms or definitions in `apps/web/`, `ui/`, `modules/src/`, `runtime/page|app|record|query|access/` or `contracts/src/`, an independent headless Edge smoke may follow: sign in, open the CRM Companies list, open New company and save. These are diagnostics, not per-PR merge gates. Do not assume an automatic watcher exists. The lead assigns one independent preview owner for any run. The source reviewer may own the run only if it did not author or fix the product candidate under verification; otherwise assign a separate monitor. A FAIL, skipped run, mismatched SHA or unavailable stack is recorded truthfully, never called PASS and never used alone to hold a PR. A confirmed candidate defect returns to source review and correction; unrelated verified PRs keep moving.

After a merge batch touching definitions, migrations or development setup, independently smoke-test main when the safe stack is available. Record an unavailable or failed smoke with a concrete recovery owner; continue unrelated verified merges. The phase walkthrough remains a separate independent browser acceptance run before closing the phase epic; reserve a child slot and pause conflicting preview operations while it runs.

## Issue metadata

Each implementation leaf title starts `#<issue>` and the issue includes its phase label, numeric Pickup Order and:

- Summary
- Already built
- Remaining work
- Scope boundaries
- Acceptance criteria
- Specification references
- Blocked by and Blocks

No test instructions or proof checklists. Parent estimates total their children. The lead records the actual session/model/effort, implementation and review estimates, assigned worktree and branch, UTC start and finish, PR and candidate/reviewed/merged SHAs, checks, preview owner, migration reservation and blocker in the checkpoint.

## Project board and API budget

The lead is the sole board writer. At each transition, journal the intended Project mutation before sending it, update only changed fields, read back the affected row and append evidence to the local journal. If a write is pending, report the board as STALE and keep the pending operation through restart.

| Event | Project state |
| --- | --- |
| Leaf shaped and dependency-ready | Ready, with planned role and estimate where available |
| Implementer actually starts | In progress, with actual session/model and start time |
| PR opened | In review, substate awaiting reviewer |
| Reviewer starts, fixes or verifies | In review with the truthful substate |
| Blocked, failed or reassigned | Truthful status, exact cause and next action; clear the old owner |
| Leaf PR merged and issue closed | Done after board read-back; update dependents and parent rollups |

Worker stages and parent or phase rollups are different facts: a parent's status follows verified child outcomes, and a phase stays open until independent end-to-end acceptance. A rollup can become Done after its required children and acceptance complete, its issue closes and its board row is read back; it need not have its own PR. A reviewed local branch without a PR is a preserved substate, not a mergeable PR or Done item. Reconcile the whole Project hourly when budget allows. An open issue is never Done; a closed issue is Done or Not planned. Never infer progress from a partial board read or an agent's claim.

REST and GraphQL budgets are separate. Trust live headers and GraphQL error arrays, even on HTTP 200. Cache Project item, field and option IDs and share the cache. Refresh active PR facts conditionally about every 60–90 seconds only while useful. Coalesce and serialize writes, status first, with one targeted read-back. Reserve 20% of the hourly GraphQL budget for live transitions. Honor Retry-After and reset headers with bounded backoff and jitter. When exhausted, journal pending work, check if the write already succeeded before retrying, and wait for reset. Never rotate credentials to defeat a limit. Unknown, stale or partial evidence never means an empty backlog, PASS or permission to merge.

## Provider availability and retained fleet artifacts

The Orca handover is complete; its archived inventories and reports are evidence, not instructions to restart those services. Do not attach new work to an archived or retired Run or restart retired services; reuse the current lead-owned Run recorded in the checkpoint. The owner-authorized pool has no separate model coordinator, board writer or merger. For current provider status, read the lead-owned `provider-routing.md` in the coordination root; the dated facts below are not a standing dispatch guarantee:

- Orca-hosted Codex Luna Extra High is an authorized headless overflow lane; verify the actual worker and shared-account capacity for each start.
- Antigravity currently advertises `gemini-3.8-flash-high`, medium and low. Requested Extra High is not advertised; a CLI `max` option has no verified runtime mapping. Do not label High or max as Extra High or silently substitute it.
- OpenCode Kimi K3 is owner-authorized but absent from the connected model catalog. No worker is established by the requested model name; wait for a connected, verified provider.
- Multiple bounded OpenCode Space Bunny workers are authorized in principle, and the catalog exposes `opencode/space-bunny-free`, but two attempts were rejected by `external_directory` while reading fleet policy. These are blocked, not running. Do not retry those denied reads unchanged, alter the permission control, or move the read to another executor. The owner must grant the specific policy and coordination directory access through OpenCode's supported controls, without a blanket allow; verify one successful worker before scaling or counting others.

Headless custom-argv workers must have exact terminal/process ownership, durable output and exit records; do not claim supervised resource ownership when the runtime reports unsupervised. Codex lanes use `codex exec`, never interactive daemon-backed terminals. Preserve unique work from old branches and checkouts. Reuse an old checkout only after proving no session or process relies on it; use lead-assigned isolated managed worktrees for new product edits. A heartbeat is a recovery reminder while the app runs, not unattended fleet execution.

## Stall and failure recovery

| Observation | Action |
| --- | --- |
| Child asks a scope question | Lead records the answer in the issue or PR and updates scope before the child continues |
| A real design gap blocks work | Use a bounded Sol analysis; owner decides product questions, then relaunch from the recorded decision |
| No useful progress during an active turn | Inspect native status, branch and worktree; ask one bounded question if unclear |
| Child ends without a PR or report | Read available handoff evidence, preserve work, and inspect the branch before resuming or reassigning |
| A blocker stops a child | Preserve its branch and handoff, record the exact unblock condition, release its slot, and dispatch unrelated verified work in the same active turn |
| Provider capacity or rate limit | Retry the same session a few times about 20 seconds apart; then preserve work and reassign only after repeated confirmation |
| Reviewer finds defects | Reviewer fixes and re-reviews in its assigned worktree |
| Branch is behind main | Update the candidate, inspect changed code and rerun affected verification |
| Optional preview or browser check fails | Record the failure and recovery owner; diagnose and fix through a PR when it reveals a product defect. Do not report PASS or close phase acceptance from a failed check. An unrelated verified PR can still merge. |
| Permission, tool-approval or protection rejection | Report exact action and cause; do not automatically retry the denied invocation unchanged or bypass it. A later specific owner instruction may authorize a fresh request through the same normal controls; record it and stop again if rejected. |
| PR creation or merge returns a real integration 403 | Preserve the reviewed branch and evidence, report the access blocker, and wait for a supported resolution; do not retry through another identity or executor |
| Session or usage limit approaches | Update checkpoint with resume steps and reset information; preserve branch and handoff evidence |

For every noticed product or operational failure, record the symptom, proven cause or explicit hypothesis, bounded correction, durable prevention, independent read-back and next relevant recheck. A repeated failure needs a new diagnosis and one owner escalation, not a blind retry. Keep original failure evidence distinct from diagnostic or later acceptance evidence.

## Implementer handoff template

~~~text
Issue #<n>; phase <n>; pickup <n>. Assigned owner-authorized model and effort: <verified model and effort>; execution host: <native Desktop, Orca, Antigravity or OpenCode>.
Ownership: <native agent/session ID, or external task + dispatch + terminal + process identity>; lead: <Desktop lead ID>. Record actual runtime model and effort with evidence; requested settings or a catalog entry alone are not proof.
Read AGENTS.md, docs/build-plan/agent-coordination.md, the full issue and comments, linked spec and current source.
Outcome: <plain functionality>. Already built: <source facts>.
Build: <bounded change>. Owning paths: <paths>. Exclude: <non-goals>.
Dependencies (complete): <list>. Acceptance: <inspectable behavior>.
Assigned managed worktree/branch: <path> / codex/<issue>-<slug>. Migration numbers: <range or none>.
If modules/src changes, run the definition validator and fix every failure before committing.
Do not run heavy checks or create, edit or run tests.
Review the full final diff and affected callers, correct findings, and report the cases reviewed even if none were found. Commit and report the full candidate and base SHAs, changed paths, acceptance mapping, findings and corrections, edge cases, checks with exit codes, pending limits and actual runtime model/effort. Push only with an explicit branch refspec; never push to main. Open a PR if assigned.
English only. No Project-field writes, issue closure or merges.
Return: PR if opened, complete self-review packet, candidate commit, validator result and limitations.
If a real scope or design question blocks you, preserve unique work, report the exact issue to the lead and stop without a partial PR. A PR-creation 403 is an integration blocker, not a reason to delete a reviewable local candidate.
~~~

## Reviewer handoff template

~~~text
You are the independent GPT-6 Sol (Codex Desktop native subagent, High for ordinary bounded review; Extra High for sensitive work) reviewer/fixer for issue #<n>, PR #<pr or unavailable>.
The implementer has stopped. Use your separately assigned managed worktree on the preserved candidate or PR branch.
Read the complete live issue and comments, linked spec, whole diff, current main and affected callers.
Fix your findings, commit, and re-review the final source. Check English in the diff, commits, PR and comments.
Verify the exact final SHA as agent-coordination.md “Verification before merge” requires:
scoped typecheck; web build if web/ui/imported runtime changed; disposable replay if supabase changed;
definition validator and publication compile when definitions changed. Preview/browser diagnostics are optional per PR and require exact-head reporting if run; phase acceptance remains separate.
Request the exact-head checks from the lead with the PR, full SHA, command and isolated resource. No global lock grant is required. Return one evidence packet with your verdict, final candidate SHA, checks and results, fixes and limitations. Do not claim a local branch is mergeable without a PR.
Do not write Project fields, close issues or merge. The lead owns those actions.
If blocked, return the exact cause to the lead and stop without merging.
~~~

## Checkpoint, journal and reporting

Keep the checkpoint and append-only journal in the coordination root, outside worktrees. The checkpoint is facts, not policy. Record:

- UTC time, coordinator identity and current session;
- each live child session, role, actual model and effort, issue, worktree/branch, stage and handoff status;
- open PRs, current full heads, review, verification and preview state;
- measured verification capacity, resource-scoped preview ownership and per-PR missing-gate queues;
- migration reservations and pending board writes;
- preserved work and cleanup decisions;
- blockers with resume conditions and next shaped leaves.

Append transition events and replace checkpoint snapshots atomically. Update at each material transition, periodically while active and before a known session limit or shutdown. On resume, compare checkpoint and journal with current Desktop child status, actual processes, worktrees, PR heads, board state, pending writes and locks. An uncertain worker is active until investigated. If a session is unavailable, recover from its preserved branch and handoff evidence in a fresh session; never claim its conversation was imported.

Owner reports include: tasks with evidence; actual capacity, running children and reasons for idle slots; accepted progress and PR/review age; and coordination issues with cause and correction. State stale sources and limitations. Never infer completion from a summary, partial board read or child claim.

## Independent monitor

An independent Sol child may verify preview facts, run optional per-PR browser diagnostics, conduct the required phase-acceptance walkthrough and compare evidence with the full final SHA. It reports findings and corrections to the lead. It does not dispatch work, write Project fields or merge. No monitor runs continuously unless a separate owner instruction establishes that work.

## Overflow lifecycle and retained work

The lead maintains one mixed-host roster and qualified queue. Before any external launch, reconcile native occupancy, provider catalog and permission state, existing attempts, measured memory and exact process identities. Read the live `provider-routing.md`, `capacity-roster.json` and checkpoint in the coordination root; they hold the current provider facts, Run, Dispatch, terminal and process identities. Do not duplicate an uncertain start or scale a provider whose startup, permissions or output delivery remain unverified. The commands below describe the current Orca CLI; load its version-matched `orca-cli` and `orchestration` skills before use. On Windows, select the exact executable from `ORCA_CLI_COMMAND` if set, otherwise `orca-dev` when `ORCA_DEV_REPO_ROOT` is set, otherwise `orca` (`orca-ide` outside a managed terminal on Linux). Use that one executable for every command; stop on a resolution or skill-load error. The examples use `orca` as the selected executable.

1. **Bind the lead's Run.** Run `orca skills get orca-cli` and `orca skills get orchestration`. Record the existing Desktop lead-controlled Orca shell terminal handle; if none exists, create one non-agent control shell with `orca terminal create --worktree path:<lead-checkout> --title "Desktop lead control" --json` and record its returned handle. Run `orca orchestration run-current --from <lead-terminal> --json`. If the checkpoint already names a current lead-owned Run, inspect it with `orca orchestration run-show --id <run-id> --json` and bind it with `orca orchestration run-use --id <run-id> --from <lead-terminal> --json` when needed. Only if there is no valid current Run, use `orca orchestration run-create --objective "<bounded fleet objective>" --from <lead-terminal> --json` and persist its ID. The shell is only the Desktop lead's control handle, not another coordinator; never create a new Run to escape a failed attempt.
2. **Place and start one worker.** The lead creates or selects an isolated Orca-managed worktree: `orca worktree create --repo path:<repo-root> --name <issue-name> --base-branch origin/main --no-parent --json`, or `orca worktree show --worktree path:<assigned-checkout> --json` for an existing one. Confirm the returned exact path and worktree ID, current base, clean ownership and disjoint editing paths. If the created branch is not the required non-tracking `codex/` branch, create it from current `origin/main` with `git switch --no-track -c codex/<issue-slug> origin/main` in that worktree before dispatch. For a supported headless launch, run `orca orchestration worker-start --spec "<complete bounded handoff>" --worktree path:<assigned-checkout> --agent <verified-agent> --run <run-id> --from <lead-terminal> --json`. Supply `--model` and `--effort` only where this installed CLI and provider support them; OpenCode model choice is configured in its provider session rather than by these flags. The receipt must say ready and provide Task, Dispatch and terminal identities. A nonzero or uncertain start is not an invitation to launch again: inspect its receipt and `orca orchestration request-show --request <request-id> --json` or `worker-show` before recovery. Codex workers must remain headless `codex exec`; do not use a standard launcher that opens an interactive daemon-backed Codex session.
3. **Use the custom-argv gap only when required.** When `worker-start` cannot express the approved headless argv or topology, load `orca skills get orchestration --reference references/low-level-topology.md`. Create a Task with `orca orchestration task-create --spec "<complete bounded handoff>" --run <run-id> --json`, then a shell terminal with `orca terminal create --worktree path:<assigned-checkout> --title "<issue>" --json`. Run `orca orchestration dispatch --task <task-id> --to <returned-terminal-handle> --run <run-id> --return-preamble --json` **without** `--inject`; save the exact returned preamble, including its Task specification, as the runner's stdin file. Pin and inspect the one-use runner, exact headless `codex exec` executable/model/effort/checkout argv and input bytes before launch. The runner opens that file as stdin, writes stdout and stderr to separate durable files, and records its PID, startup warnings and actual agent exit code. Send the exact runner invocation once with `orca terminal send --terminal <returned-terminal-handle> --text "<pinned runner invocation>" --enter --json`; on an input-accepted-only or ambiguous receipt, inspect that same terminal/process and receipt rather than resending. This context-only Dispatch supplies Task and message identity but **does not supervise or close** the operator-created process. Record the terminal, process and named lead cleanup owner. A shell prompt or command acceptance is not proof of a running worker; verify the agent's first turn and actual model/effort before counting it.
4. **Prove activity and receive the handoff.** Record the Task/Dispatch, worktree/branch, provider session, terminal/PID, actual runtime model and effort, and first real agent turn in the roster; a requested model, catalog row or accepted input is insufficient. Inspect with `orca orchestration worker-show --dispatch <dispatch-id> --json` and bounded `orca orchestration worker-read --dispatch <dispatch-id> --source auto --limit 50 --json`; preserve the source and cursor when following output. Wait with `orca orchestration check --run <run-id> --terminal <lead-terminal> --wait --types "worker_done,escalation,question" --timeout-ms 60000 --json`. Process every returned FIFO Delivery (the type filter controls waking, not which delivery is returned). Match its Task/Dispatch to the active roster, answer questions, and validate a `worker_done` report against the candidate, self-review and required evidence before `orca orchestration check --run <run-id> --terminal <lead-terminal> --ack <delivery-id> --json`. Persist the delivery and acknowledgment. An unrelated optional connector diagnostic is not a process exit.
5. **Settle and retire the exact resources.** A valid settled Dispatch may be reused, explicitly retained at the owner's request with `orca orchestration worker-retain --dispatch <dispatch-id> --json`, or released with `orca orchestration worker-release --dispatch <dispatch-id> --json`; follow a pending or uncertain release receipt rather than substituting `terminal close`. After three empty waits, enumerate `orca orchestration worker-list --run <run-id> --include-remote --json`, follow pagination and its exact `nextAction`, and inspect bounded output. A timeout, idle shell, null `agentWait`, missing status or lost host contact is **unverifiable**, not exit: preserve ownership and do not stop, abandon, retry or release. Only positive `exited` liveness, the worker's observed process exit, or a final agent transcript without `worker_done` permits the recovery guide's stop/abandon decision; load `orca skills get orchestration --reference references/recovery-and-cleanup.md`, then use its exact `worker-stop` or `worker-abandon` path. `worker-stop` closes only a proven supervised agent terminal; `worker-abandon` fences the Dispatch but closes nothing. For custom-argv Dispatches, neither stop, abandon nor release closes the unsupervised process: record the agent's actual exit code separately from shell/terminal liveness, then after accepted settlement and positive process-exit evidence the lead may close only its proven-unused exact terminal with `orca terminal close --terminal <handle> --json`. Confirm output preservation and process/worktree ownership before any cleanup; `orca orchestration worker-list --run <run-id> --terminal-state reclaimable --include-remote --json` exposes remaining supervised reclaimable terminals. Never bypass an authentication or approval rejection.

Recover unfinished work from each retained checkout, assign its next owner, complete its PR workflow, then retire the checkout only after unique changes and needed ignored assets are preserved. For completed work, reconcile merged/closed evidence, head ancestry, clean status, exact agent completion and shell/process ownership. A fallback shell with complete history containing only its initial prompt differs from an unverified interrupted agent. Close only exact proven-unused terminal handles, use the owning application's supported worktree lifecycle, and verify path plus Git/application registration absence. Persist each result immediately so a partial cleanup cannot be mistaken for a full one.
