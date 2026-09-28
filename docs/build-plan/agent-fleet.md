# Fleet operations

Read [agent coordination](agent-coordination.md) first: it sets the current Codex Desktop control plane, roles, capacity, lifecycle and verification. This file gives the procedure. The lead coordinates native Codex subagents in the Desktop session; no Orca dispatch, separate headless agent fleet, custom app-server or external scheduler is part of current operations. Deterministic local helpers may cache, journal or run requested checks, but cannot form a second coordinator.

The coordination root is `C:/Users/vijay/.codex/fleet/Abzum-Vortex`. Keep machine-specific checkout and process facts in the checkpoint, not in this policy.

## Resume and dispatch

1. **Resume.** Read the checkpoint and append-only journal. Reconcile native child status, actual processes, managed worktrees, open PR heads, Project state, locks and pending writes. Treat an uncertain worker as active until investigated; do not duplicate work because a session looks idle.
2. **Snapshot.** Refresh the slim, fully paginated roadmap Project snapshot at the active cadence in [Agent coordination](agent-coordination.md#board-continuity-and-rate-limits), after structural changes, and from event read-backs between snapshots. Refresh native relationships separately.
3. **Choose.** Keep a small verified pickup ledger of two or three shaped leaves. A leaf is eligible only when its current comments and native blockers agree, its premise holds in current source, its scope is bounded, its owning paths do not overlap an active editor, and capacity exists. Current-phase blockers and Pickup Order break ties. Never remove a real dependency to make an issue Ready.
4. **Review first.** Give an unreviewed open PR priority. Allocate a fresh independent Sol child with its own managed worktree before starting additional implementation. Merge readiness does not permit a worker to merge; the lead makes the final decision.
5. **Fill only useful capacity.** Default to one implementer, one reviewer and one flexible child when the live capacity supports it. Dispatch an idle implementer to a verified leaf in the same active turn. If none qualifies, shape the highest-value Backlog candidate and record the missing prerequisite. Dispatch another implementer only if paths are disjoint and review is keeping up. For a review backlog, prefer one implementer and two reviewers. Reserve a child for an independent phase walkthrough. Do not claim empty work or dispatch capacity from partial data.
6. **Shape and assign.** Follow [Shape before dispatch](agent-coordination.md#shape-before-dispatch). Existing implementation goes to independent review and reconciliation, not reimplementation. Assign a lead-owned isolated managed worktree, branch, issue and explicit owning paths before the child edits.
7. **Recompute.** After a handoff, merge, closure, board transition or blocker, refresh the affected evidence and reconsider eligible work in the same active turn. Preserve a blocked child's unique work, release its slot and continue independent leaves. Do not run an always-on poller.

The current Desktop session exposes up to three child slots; verify the actual limit at each session and never imply more capacity. A child does not inherit a private checkout or durable background execution automatically. Native work may be interrupted by user input, app closure, context or shared usage limits. Preserve a recovery point and keep coordination claims honest.

## Native subagent handoffs

Every handoff records issue and outcome, complete dependencies, acceptance, scope boundaries, assigned worktree and branch, migration reservation if any, actual model and reasoning effort, and the exact requested deliverable. Use the issue's complete context, not an abbreviated summary. Workers report evidence and blockers to the lead.

- **Read-only inventory or summary:** Luna, Extra High, only when delegation saves work; supply exact sources and questions. Require source evidence for claims and keep it bounded.
- **Implementation:** Luna, Extra High for implementation, self-review and corrections. The lead assigns the managed worktree and checks ownership and path boundaries. The implementer validates definitions when needed, commits, and returns the complete self-review packet, candidate SHA, changed paths, acceptance mapping, validator result, limitations, and whether a PR was opened.
- **Review and fix:** fresh Sol, High for ordinary bounded review; Extra High for privilege, authentication, SQL ownership, tenant boundaries, transactions, architecture or unresolved cross-layer failures. Use a separate session and worktree after the implementer stops. The reviewer reads the live issue and all comments, specification, complete diff, current main and affected callers; fixes findings; re-reads changed context; re-reviews; and returns the exact-head verdict, checks and limitations to the lead. It never merges. Reuse the same independent reviewer for later acceptance of its candidate when appropriate.
- **Planning:** Sol, High or Extra High for bounded architecture options and issue shaping. Astra, High is an exceptional consultation only for a named unresolved decision. No external model is dispatched under current policy.
- **Independent monitor:** Sol, High when needed for preview evidence or phase acceptance. Keep it independent from implementation. It does not become a permanent service.

Reasoning is selected by risk. Keep Luna Extra High for implementation and corrections. Sol High ordinary review is a measured pilot, while sensitive review stays Extra High; neither changes independence or verification. Record actual model and effort; do not infer them from the plan label. Compare rework and acceptance before changing routing further. Optimize cost per accepted change, not the number of simultaneous agents.

Before independent review, the Luna handoff names the full candidate and base SHAs, changed paths, acceptance-to-source mapping, focused final-diff and caller self-review, actual findings and corrections (or reviewed cases when none), edge cases, checks with exit codes, and pending limits. The lead returns an incomplete packet to the same Luna session; it does not invent evidence or spend a Sol slot on an incomplete handoff. See the [implementer template](#implementer-handoff-template).

## Branches, worktrees and migrations

- One issue has one editor and one lead-assigned isolated managed worktree at a time. Base new work on current `origin/main`. Create branches with `--no-track`; use the `codex/` branch prefix unless the owner or repository procedure says otherwise. A reviewer uses its own isolated managed worktree on the PR branch.
- Never push to main. Push only with the explicit refspec `git push origin HEAD:refs/heads/<branch>`. Verify that the branch has no upstream tracking `origin/main`. Main is protected, including for administrators.
- Before merge, the lead verifies the PR head, base and review are current. Update from `origin/main` when required, inspect merge changes, rerun checks invalidated by the new head, and re-read the candidate immediately before the protected merge. A changed head invalidates prior review or check evidence.
- When the exact-head review and all required check and preview evidence are complete, the lead attempts the protected PR merge in that active turn. Classify a failed merge as changed head or base, missing evidence, conflict, protection or integration access; record one owner and next action. Never use another identity or executor to bypass a real 403.
- Before dispatching a migration, compute the next free number from current `origin/main` and reserve it in the checkpoint. Every child takes its number only from the lead. Renumber before merge if it sorts before an existing main migration.
- Preserve untracked, uncommitted, unpushed and otherwise unique work before considering worktree cleanup. Do not remove a worktree while a child or process uses it. Retain uncertain work with an owner, reason and next action. No recursive delete by computed path, no primary-checkout removal and no cleanup against main. Never blindly revert dependent migration or subsequent work.

## Heavy checks and locks

Heavy checks are scoped typecheck, web build and database replay. There are two total slots; at most one database replay may run at a time. Use `heavy.lock` for any heavy check and `heavy.lock2` for typecheck or build only. Do not start when less than 3 GB of memory is free.

The lead owns locks and queue state. Each reservation records owner identity, process start time, task and commit; release it as soon as the command ends. A stale timestamp alone never licenses stealing a lock. Confirm the owner process has exited and the reservation is no longer active before recovery. Reviewer asks the lead for a lock; the lead serializes the request and returns the grant. The lead coordinates priority and the current phase's blockers. Never start a heavy check merely to satisfy a stale label; use the exact verification requirements and candidate SHA.

## Preview checks and browser smoke

The shared preview stack is local. The lead assigns one independent preview owner at a time; no concurrent database reset or setup operation is allowed. Capture the stack state and exact commit before each check.

For definitions, migrations or `apps/web/scripts/development-setup`, require independent preview PASS on the exact full head: fresh `db reset` and `setup:local`. For pages, forms or definitions in `apps/web/`, `ui/`, `modules/src/`, `runtime/page|app|record|query|access/` or `contracts/src/`, also require independent headless Edge smoke PASS on that head after preview reset: sign in, open the CRM Companies list, open New company and save. Do not assume an automatic watcher exists. The reviewer requests the independent run and waits for evidence from the assigned monitor. A FAIL, skipped run, mismatched SHA or unavailable stack means do not merge.

After any merge that touches definitions, migrations or development setup, independently smoke-test main. A main failure holds further merges of that kind until the cause is diagnosed and a corrective PR is verified. The phase walkthrough is a separate independent browser acceptance run; reserve a child slot and pause conflicting preview operations while it runs.

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

## Retired fleet artifacts

The Orca handover is complete; its archived inventories and reports are evidence, not instructions to restart those services. Do not dispatch through Orca, launch a headless Codex CLI agent fleet or attach new work to an old run. Preserve unique work from old branches and checkouts. Reuse an old checkout only after proving no session or process relies on it; use Codex-managed worktrees for new work. A heartbeat is a recovery reminder while the app runs, not unattended fleet execution.

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
| Preview or browser check fails | Do not merge; diagnose and fix through a PR, then rerun on its new SHA |
| Permission, tool-approval or protection rejection | Report exact action and cause; do not retry unchanged or bypass |
| PR creation or merge returns a real integration 403 | Preserve the reviewed branch and evidence, report the access blocker, and wait for a supported resolution; do not retry through another identity or executor |
| Session or usage limit approaches | Update checkpoint with resume steps and reset information; preserve branch and handoff evidence |

For every noticed product or operational failure, record the symptom, proven cause or explicit hypothesis, bounded correction, durable prevention, independent read-back and next relevant recheck. A repeated failure needs a new diagnosis and one owner escalation, not a blind retry. Keep original failure evidence distinct from diagnostic or later acceptance evidence.

## Implementer handoff template

~~~text
Issue #<n>; phase <n>; pickup <n>. GPT-6 Luna (Codex Desktop native subagent; Extra High).
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
definition validator and publication compile when definitions changed; independent preview PASS on exact SHA
for definitions, migrations or development setup; browser smoke on exact SHA for listed UI paths.
Request the heavy-check lock from the lead. Return one exact-head evidence packet with your verdict, final candidate SHA, checks and results, fixes and limitations. Do not claim a local branch is mergeable without a PR.
Do not write Project fields, close issues or merge. The lead owns those actions.
If blocked, return the exact cause to the lead and stop without merging.
~~~

## Checkpoint, journal and reporting

Keep the checkpoint and append-only journal in the coordination root, outside worktrees. The checkpoint is facts, not policy. Record:

- UTC time, coordinator identity and current session;
- each live child session, role, actual model and effort, issue, worktree/branch, stage and handoff status;
- open PRs, current full heads, review, verification and preview state;
- lock and heavy-check queue state;
- migration reservations and pending board writes;
- preserved work and cleanup decisions;
- blockers with resume conditions and next shaped leaves.

Append transition events and replace checkpoint snapshots atomically. Update at each material transition, periodically while active and before a known session limit or shutdown. On resume, compare checkpoint and journal with current Desktop child status, actual processes, worktrees, PR heads, board state, pending writes and locks. An uncertain worker is active until investigated. If a session is unavailable, recover from its preserved branch and handoff evidence in a fresh session; never claim its conversation was imported.

Owner reports include: tasks with evidence; actual capacity, running children and reasons for idle slots; accepted progress and PR/review age; and coordination issues with cause and correction. State stale sources and limitations. Never infer completion from a summary, partial board read or child claim.

## Independent monitor

An independent Sol child may verify preview facts, run required browser smokes, conduct phase acceptance and compare evidence with the full final SHA. It reports findings and corrections to the lead. It does not dispatch work, write Project fields or merge. No monitor runs continuously unless a separate owner instruction establishes that work.
