# Agent fleet operations

Vortex development runs as an autonomous agent fleet inside Orca, an agent
development environment external to this repository. One generic root
orchestrator sequences issues, supervises and reports; a multi-slice issue has
one issue owner that plans and supervises its slices, and implementer agents do
the work in isolated worktrees, one agent per terminal per worktree per branch.
This document is the operational reference for that fleet: the roster, the
root and issue-owner split, the escalation ladder, how the next task is chosen,
how a running agent is checked, the gates a task must pass, the branch and
promotion model, the dispatch brief template, and what the root decides alone
versus what it parks.

Read [agent coordination](agent-coordination.md) first. It defines the
coordination roles, the board status meanings and the completion handoff that
apply to this work regardless of how a session is launched. This document
defines how the fleet runs those rules unattended, and does not restate them.

**The objective is delivered functionality.** Agents implement and verify real
behaviour. "Improve the tests" is never a task on its own, and a task that
turns into test maintenance instead of delivering the functionality it was
dispatched for has drifted from its brief.

## Root model and launch pin (latest direct user rule)

The current root stays in the same session and Run as GPT-5.6 Sol low. Astra
is allowed only for architecture-level tasks, not routine coordination, coding
or routine review. Future root launches must explicitly use
`codex --model gpt-5.6-sol -c model_reasoning_effort="low"`; saved defaults are
insufficient because a higher-priority configuration can override them. Do not
restart the current root just to change defaults. Do not launch a second root.
Lower-cost Antigravity/OpenCode/Sonnet/Terra workers remain preferred.

## Topology

Orca's unit of work is the agent session: one CLI agent in one terminal in one
worktree. Each agent has its own disposable checkout to work in, and the
orchestrator can discard a branch without touching anyone else's work. Orca
launches agents with their configured permissions: the worktree is the
sandbox. Do not alter tool permissions or diagnose a lane as broken merely
from a prior permission report. The orchestrator never edits another agent's
worktree; it steers by sending text into that agent's terminal and by reading
the terminal back. Sandboxed agents receive an inline brief or a brief placed
in their own worktree. Existing OpenCode allow configuration is user-owned:
agents do not change it or introduce global wildcard permission rules. A custom
`agy` command must explicitly include the user-selected
`--dangerously-skip-permissions` flag; that command-specific requirement does
not authorize a global permission change.

## Current cost routing and supervision (21 September 2026)

The latest direct user instruction takes precedence over historical lane defaults.
Keep one generic GPT-5.6 Sol low root and reuse the existing issue owners. For
new routine implementation, fixture, registration, evidence and non-DB work, prefer Antigravity
Gemini 3.8 Flash, OpenCode GLM 5.3, or Claude Sonnet after checking actual availability.
Do not create routine Sol or Astra workers. Apart from the existing coordinator
and owners, reserve Sol for genuinely complex
analysis or security review. Existing near-finished workers may complete their
bounded task without a provider switch. Do not discard partial edits to change models.

Owners dispatch real, bounded, non-overlapping tasks in retained worktrees and
verify the resolved model, canonical task/dispatch, terminal and actual task activity.
Input acceptance alone is not a start. Re-list handles after runtime restarts.
At a safe provider handoff, preserve edits and evidence and prove the old editor
has stopped before starting its replacement. Custom `agy` always includes
`--dangerously-skip-permissions`.

Keep both local DB slots useful when corrected gates are ready; root issues one
fresh allocation per invocation after reconciling releases. Never replay a consumed
grant. Run independent ready non-DB work alongside verification. A fixture failure
never authorizes wider runtime or production grants to make the harness pass.
Cards and board dispatch fields name the actual active model and owner; waiting
states identify the missing gate or dependency rather than implying active execution.

Recurring duplicate supervisor launches are disabled. Event-driven inbox delivery
continues under the sole root; do not resume the paused delivery monitor. Close
settled stale sessions only with positive completion/exit evidence, and remove
worktrees only after proving they are clean (including untracked files), merged
or unneeded, and free of active ownership. Preserve dirty or unmerged work and
all required evidence. Production remains disabled and unwanted.

## Roster and model assignment

Model choice follows the shape of the work, not seniority. Privileged
database objects and anything that can widen access get the most capable
reviewer available; mechanical, well-specified volume goes to the cheapest
agent that can do it correctly. Tune this mapping from outcomes rather than
treating it as fixed.

| Lane | Model | Does | Owns |
| --- | --- | --- | --- |
| Orchestrator (root coordinator) | GPT 5.6 Sol low (Codex) | Supervises issue owners and single-slice workers, sequences work across issues, performs independent acceptance, and decides merges and promotions. Generic: it has no linked issue or pull request and no implementation ownership. If it starts writing code, the queue stops moving. | Cross-issue dependency order, database-verification admission, phase gates, merge and promotion decisions |
| Issue owner / Planner | GPT 5.6 Sol · high (Codex) | Every issue-level orchestrator, issue owner and Planner: plans the whole issue, supervises its workers and corrects handoffs. Astra may only perform explicitly scoped architecture-level tasks. | Issue slices, worker supervision and planning evidence |
| Privileged review | Claude Opus 5 · high | Review only privileged database, security and concurrency work; do not use it as a general implementation or routine-review lane | Privileged review verdicts |
| Runtime & contracts | Claude Sonnet 5 · high | TypeScript engines, contracts, adapters and the definition-led execution path for bounded coding after actual availability is verified. | `runtime/**`, `contracts/**` |
| Proofs | Claude Sonnet 5 · high | pgTAP suites and the two-session concurrency harness; builds every fixture through the owning writer, never by direct insert; reports defects rather than softening assertions. | `supabase/tests/**` and verification registration |
| Workhorse (OpenCode) | GLM 5.3 (OpenCode) | High-volume, well-specified, low-blast-radius work where the answer is checkable: plan-document sync, registration and inventory sweeps, scaffolds, evidence collection and dependency audits | `docs/**`, manifests, selectors, audits |
| Workhorse | Claude Sonnet 5 · high, or GPT 5.6 Terra · medium/high (Codex) | Bounded coding when the assignment benefits from those lanes and actual availability is verified. | `docs/**`, manifests, selectors, audits |
| Workhorse (Antigravity) | Gemini 3.8 Flash (`agy` TUI) | An allowed lane for the same workhorse tasks. Before dispatch, verify that `agy` is installed and that the exact model resolves in the launched terminal. Availability is not claimed without launch evidence. | Workhorse tasks, once launch is evidenced |
| Triage | GPT 5.6 Terra · low (Codex) | Cheap and fast: read an issue, reproduce a failure, scan logs, confirm a premise, summarise a diff. The first responder that stops expensive agents being dispatched on false premises | Pre-dispatch premise checks, failure triage |
| Mechanical workhorse | GPT 5.6 Luna | Checkable mechanical work under a concise, file-specific brief. | Mechanical `docs/**`, manifests, selectors and inventories |
| Deep analysis | GPT 5.6 Sol · high (Codex) | Root-cause work and slice design when a defect resists the obvious reading, or when an issue owner needs the issue's scope split before anyone implements it. | Diagnosis notes, slice proposals, spec deltas |
| Second lane | GPT 5.6 Terra · medium/high (Codex) | A balanced implementer for independent bounded coding. | Overflow implementation |
| REVIEW-AND-FIX owner | Claude Sonnet 5 for routine review and repair; GPT 5.6 Sol high for genuinely complex correctness or security repair; Opus privileged only | After the original editor checkpoints and stops, takes exclusive edit ownership of the preserved candidate, reproduces findings, implements scoped fixes, runs affected checks, and returns the exact diff or commit plus evidence in one bounded assignment. GPT-6 Astra is reserved for architecture-level tasks. | Reviewed-and-fixed outcome, remaining acceptance gaps, and evidence |

GPT lanes run through Codex's native worker mechanism; Claude lanes run as
Claude Code agents; the Antigravity lane runs through the `agy` TUI. Do not
substitute an external CLI or another provider for a named worker —
[agent coordination](agent-coordination.md) governs how a resolved model and
session are recorded.

Documentation, manifests, inventories, dependency audits and evidence gathering
are cost-routed to Gemini 3.8 Flash or GLM 5.3 for bounded contracts,
fixtures, documentation, evidence and mechanical work; Luna is also permitted
for mechanical work. Use Terra or Sonnet for bounded coding, and Opus or Sol
for complex authorization or SQL/security-sensitive review. Cost is measured by
successful delivery. Verify a launched terminal's readiness, resolved model and
actual task activity before claiming availability. Claude's reset is confirmed:
the next useful bounded Claude dispatch verifies actual availability, never a
synthetic test. GLM capacity also requires actual verification; do not retry in
a loop. Retain a demonstrated failure and reassign once or report the blocker.

Before every assignment, inspect Orca's live status-bar usage roster and record
its observation timestamp and available headroom in the assignment evidence.
Choose an available lane; never queue work behind an exhausted model. Usage
figures are live observations, not fixed thresholds, so do not copy historical
percentages into a rule. Near-finished workers finish. Otherwise, migrate only
at a checkpoint: its owner records concise state, file-specific findings, exact
next step, edits, commits and evidence in the dossier, then stops that exact
agent. The root records the handoff on the issue; the owner transfers the work
to a fresh worktree on one available lane, with no duplicate editor or repeated
analysis. Owners supervise at checkpoints with concise file-specific briefs and
evidence paths, not verbose polling or full-context rescans. The owner/planner
remains Sol; do not create Astra children. Opus remains privileged-only: if it
is unavailable, report that through the root on the issue and continue with the
next independent task rather than waiting. The user's current authorized Sol
and Terra privileged recoveries remain available.

For any Antigravity dispatch, confirm in the launched terminal that the exact
model is Gemini 3.8 Flash, and record the terminal and observed model with the
dispatch. Do not describe the lane as available on the strength of the roster
entry alone. Record the terminal and observed model for every other launch too.
Every custom Antigravity command includes the user-selected permission flag,
for example `agy <selected arguments> --dangerously-skip-permissions`. This is
an explicit per-command argument, not permission to modify a global rule.

## Escalation ladder

The ladder is two rungs, not a staircase. A task that stalls or fails twice
while assigned to **GPT 5.6 Terra, Gemini 3.8 Flash or GLM 5.3**
escalates directly to GPT 5.6 Sol (high). Escalate to Claude Opus 5 (high)
only for privileged database, security or concurrency work — nothing in
between.
Escalating one model at a time re-runs the same failure at each intermediate
step instead of resolving it.

Escalation carries the failure forward: the new brief states what was already
tried and why it failed, so the stronger model does not repeat it. A task
that still fails at that top rung returns to the Sol owner for a documented
next-action decision, not a third implementation attempt.

## Root coordinator and issue owners

The root coordinator is the sole generic GPT-5.6 Sol low orchestrator. It is generic: it is
not linked to any issue or pull request and owns no implementation. The root is
the sole GitHub reader and issue/board mutation owner, publishes the shared
evidence described below, performs independent acceptance, and decides
promotion. Owners and workers make zero GitHub reads and no issue or board
writes; they may push branches and open a review pull request only when
explicitly authorized.

**A multi-slice issue gets one GPT-5.6 Sol issue owner.** The owner reads the full issue,
plans its own slices, dispatches and supervises its workers, and owns acceptance
and board evidence and reports until the whole issue is done. The root briefs the
whole outcome and its constraints, never a per-slice decomposition. Dispatch a
worker directly only for a genuinely single-slice issue.

Owners are bound by the same rules as the root:

- The blocking completion and resume gate, terminal monitoring and worktree
  cleanup below apply to each owner for its own issue and workers.
- Owners dispatch workers freely. There is no maximum number of agents,
  owners or workers, and no slot request or permission is required to spawn a
  worker. The only shared limit is the two concurrent `pnpm db:*` verification
  clusters described in Queue selection; workers queue for a cluster, not for
  permission to exist.
- Each database-verification owner receives one reservation window covering at
  most three attempts or 30 minutes elapsed from the recorded window start,
  whichever happens first. Within the window, the owner or exclusive
  REVIEW-AND-FIX owner may correct an attributable fixture or harness failure
  and rerun after an actual diff without another root approval. Every attempt
  has a unique identity, timing, result, and cleanup receipt. Stop on an
  unchanged failure, product-scope change, ambiguous cleanup, or budget expiry;
  never replay an attempt blindly.
- The root oversees owners and each owner oversees its workers. Existing
  non-Sol owners transition at safe handoff boundaries without losing drafts or
  evidence; no duplicate owner or Astra child is launched. Every handle and
  observation is recorded, and an existing worker is never duplicated. A worker
  already running on part of the issue is adopted under the new owner, not
  restarted.
- An owner may push its branch and open a review pull request only when that is
  authorized. Owners and workers make no GitHub reads or issue/board writes and
  neither role reconciles board records. The root keeps board updates, merge and
  promotion decisions, and independent acceptance.

### Central GitHub snapshot and issue dossiers

At the start of each root cycle, the root makes one serialized, complete
live-board read and writes
`C:/Users/vijay/AppData/Local/Temp/vortex-fleet/board-snapshot.json`. Its first
field is `snapshotUtc`. Owners and workers consume that snapshot; nobody else
runs `gh project item-list` or performs another full-board refresh in the same
cycle.

When assigning an issue, the root creates the timestamped
`C:/Users/vijay/AppData/Local/Temp/vortex-fleet/issue-<n>.md` dossier from its
serialized GitHub access. It includes the issue body, all comments, `blocked_by`
and blocking edges, subissues, and linked pull requests. It preserves all
dependency edges as audit evidence and filters to `state=open` only when
deciding eligibility. Owners and workers reuse the dossier and make no GitHub
reads or issue/board writes. A request for fresher mid-cycle data goes to the
root, which makes the single authorized targeted call rather than a duplicate
refresh.

### GitHub call discipline

The root is the only GitHub reader and issue/board mutation owner. It makes one
complete board snapshot per 30-minute root cycle and any necessary serialized
targeted calls; owners and workers make no GitHub reads or issue/board writes.
Never endpoint-poll: wait on agent terminals.
On a rate-limit error, stop, honor the response `Retry-After` or reset time,
make exactly one retry, and report the result. If no reset is supplied, do not
invent one or tight-loop; escalate. A rate-limit response or unknown owner type
may be throttling, not proof that the data is invalid.

The following are user-observed operational measurements, not universal
constants: REST core 5,000/hour (283 used when measured), GraphQL 5,000 points
per hour, search 30/minute, and code search 10/minute. Secondary burst or
concurrency throttling can occur while those measured quotas remain.

## The dispatch loop

The orchestrator runs one loop, continuously, without waiting for a human.
Every pass with startable work produces at least one executable advancement:
accept, land, verify, repair, or dispatch. Prefer the existing owner, worker and
worktree. Bookkeeping alone is not output. If none advances, report each issue
examined, its exact blocker, accountable owner and unblock event. The loop stops
only when the board has no executable work left.

Every startable issue has an accountable owner. For a genuinely single-slice
issue, the directly dispatched worker is that owner for the bounded task; the
root still does not decompose a multi-slice issue into its workers.

1. **Select** — pick the next dependency-ready task; see Queue selection below.
2. **Brief** — verify the premise from the root-published snapshot and issue dossier,
   then write a drift-proof brief; see Dispatch brief template below.
3. **Dispatch** — reuse the accountable owner and preserved worktree when safe;
   otherwise start one agent in one isolated worktree on one branch. The agent
   is an issue owner for a multi-slice issue and a worker for a single-slice one;
   see Root coordinator and issue owners above. For example:

   ```
   orca worktree create --repo id:<repoId> --name <branch-name> \
     --agent claude --setup run --parent-worktree active \
     --prompt "$(cat brief.md)" --json
   ```

   Immediately verify that the actual agent is attached and shows real task
   activity before recording the task as started. Deliberately recover or close
   an orphan worktree; never ignore it.

4. **Watch** — check the agent at least every twenty minutes; see Watching below.
5. **Gate** — transfer the checkpointed candidate to a REVIEW-AND-FIX owner and run the applicable local verification; see Gates below.
6. **Land** — open the pull request into `main` (an issue owner may open it
   for review only when authorized) and merge once gates and review pass; the
   root decides the merge. Promotion to `testing` remains a separate phase
   gate, subject to any user hold.
7. **Reconcile, decide and continue — immediate step.** Immediately after an
   agent finishes, its owner reports completion to the root. In the same turn,
   the root batches truthful issue-field changes, confirms the row, and gives the
   result one disposition: accept/deliver it, verify one bounded next dispatch,
   or record the exact dependency blocker, accountable owner and unblock event.
   A status update or vague “pending root approval” is not completion. Drain
   executable Ready handoffs through existing owners before adding supervisors
   or ending the turn.
8. **Clean up.** Once the branch is merged and the board row is verified, remove
   the finished checkout with `orca worktree rm`; see Worktree cleanup below.

### Blocking completion and resume gate

After every worker completion, reviewed-and-fixed result, merge, hosted result or closure,
and before the first dispatch after a resume, the root applies this central
protocol:

A stopped talking or done pane is not task completion. Before marking work done
or removing its worktree, the issue owner reviews every dirty diff and confirms
that the work was committed and pushed, or that it was explicitly discarded with
the reason recorded by the root on the issue. Preserve partial and untracked
evidence until that decision. A merged base alone never authorizes cleanup; the
generic root's supervising worktree is exempt from merged-worktree cleanup.

Do not pause at a completion receipt when authorized work remains executable.
The root makes engineering acceptance and merge decisions from the evidence;
owners prepare evidence, perform scoped repairs and run affected checks. Failed
or timed-out checks require attributable diagnosis plus affected proof. Never
replay an unchanged full suite blindly; a bounded affected rerun is permitted
when it tests a recorded intermittent-failure hypothesis.

For completion and every model handoff, use `git status --porcelain=v1
--untracked-files=all`, not `git diff` alone, and report separate counts for
tracked modified, deleted, staged and untracked paths. Inspect untracked paths
and explicitly add untracked product files before committing. A model handoff
commits and pushes complete WIP, including untracked migrations, runtime files
and tests, or archives that complete WIP; state notes alone are insufficient.
Preserve an existing rescue archive. Suspend new dispatch behind an existing
rescue until it is deliberately recovered or closed.

After a worker reports done, the owner runs `git status --porcelain
--untracked-files=all` and `git rev-list --count origin/main..HEAD`, records
the untracked count, and verifies the branch's HEAD was pushed to the remote.
If the status is dirty, or the branch is ahead by zero despite changes, return
the work to the worker to land or discard. Do not call WIP accepted. Workers and
owners supply this evidence to the root; the root alone writes it on the issue.

1. Use the cycle snapshot and root-confirmed changed-row evidence to reconcile
   open issues against their PRs, actual branch ancestry, local gates, applicable
   hosted receipts and remaining acceptance. A merged slice is not automatically
   a completed issue. Owners do not re-read GitHub for this step.
2. Set the actual delivery stage. Use **In progress** only when a verified
   worker is actively implementing or correcting the current slice. Use **In
   review** only while an actual review is running, and **Testing** only while a
   verification execution is actively running. Queued review or verification
   is **Ready** with its exact next action. A partly completed parent with no
   active slice is Ready, or Backlog with an explicit dependency blocker when no
   Blocked option exists. Ownership, an unfinished issue, a PR, or a live idle
   session does not make work active.
   Use **Done** and close the issue only when its acceptance is met, local gates
   ran and any required hosted evidence exists. Do not return fully implemented
   work to Backlog merely because its worker finished. Backlog may describe
   genuinely unstarted remaining scope after accepted slices, which must be
   named separately with their evidence.
3. Record the real owner, canonical dispatch reference, completion time, exact
   commit/PR, checks actually run and remaining acceptance or hold. Clear completed
   workers; name the next accountable owner. Batch the issue-field changes.
   Post one closing comment citing the delivering PR and evidence only when
   whole-issue acceptance closes the issue.
4. Scan the shared board and timestamped dossiers for dependencies, filtering
   blockers to `state=open`; move every startable row to Ready or its current true state,
   derive the pickup order, and exclude #520 because it is a parked user
   decision. Keep sequencing generic and manual. Post Completed, Coming up,
   Pending User Decision and Overall Progress rows, and recount the numerator
   and denominator from the live board.
5. Read back the changed board rows and issue states. **Do not dispatch the next
   worker until these writes are verified.** A failed or incomplete reconciliation
   blocks new dispatch, not an already running worker's authorized work.

On resume, repair stale rows before continuing the queue. A local checkpoint or
watchdog handoff is not a substitute for the GitHub board. Preserve user holds;
never promote merely to make a status label fit.

Two feedback paths run outside that sequence. A stall or drift caught while
watching can be steered, re-briefed, or escalated to a stronger model,
returning to Brief. A failed gate never blocks the loop. Repair an attributable
defect as a bounded slice of the same issue by default. Create a separate
tracked issue only when the evidence proves genuinely independent scope, then
re-enter Select without stopping unrelated work.

The root refreshes its one complete board snapshot at most once per 30-minute
cycle to avoid overlapping root sessions. This is a snapshot cadence, never a
waiting barrier for completion, handoff, acceptance or executable next work.
Never create a yielding duplicate root.

Before the first database attempt in a reservation window, audit the entire
fixture setup, role changes, request context, and TAP ownership transitions
against known-good patterns. Run cheap executable lint, typecheck, and focused
tests before any independent delta check. The REVIEW-AND-FIX owner directly
repairs scoped findings. A material or security-sensitive authored delta gets
one lightweight independent delta check, not a full review loop.

Record ready-to-start time, actual start delay, attempt count, failures, window
expiry, cleanup, the real waiting blocker, and the next responsible agent in
the existing dossier and board fields. Do not create a separate observability
system. Duplicate supervision stays disabled.

## Queue selection

Order comes from the repository, not from intuition. Issue numbers, folder
names and old comments are not evidence of sequence — native GitHub
dependencies are.

1. **Collect candidates.** Open issues whose board status is Ready or Backlog.
2. **Drop anything genuinely blocked.** Use the root's shared snapshot and
   the owner's assignment dossier. Preserve all dependency edges in the dossier
   as audit evidence, but count only edges whose issue `state` is `open` for
   eligibility. An unknown state or missing dossier leaves eligibility unknown
   until the root supplies one targeted fresh read. Scan the whole shared board
   after completions and on resume, not just the old queue.
3. **Order by roadmap lane, then priority, then dependency depth.** Work that
   unblocks the most downstream issues goes first within a lane.
4. **Prefer functionality over maintenance.** Between two startable tasks,
   the one that delivers capability wins over the one that tidies coverage.
   A defect in a shipped writer is functionality; adding tests around a
   working one is not — this is the same rule that makes test maintenance an
   invalid task on its own.
5. **Reserve database-cluster verification.** At most two `pnpm db:*`
   verification clusters run concurrently across the fleet, because #384
   demonstrated clock skew from additional parallel clusters. This is not an
   agent, owner or worker cap: any number of agents may read, write, analyse or
   review while verification waits for a cluster. Do not request permission or
   a slot to dispatch them.
6. **Verify the premise before briefing.** Search the full commit history for
   the affected path and search closed issues. A fix that already exists on
   another branch is the single most expensive thing to re-implement.
7. **Dispatch, then use one grouped transition.** Mark the issue **In progress**
   only after the launched worker's resolved model and actual implementation or
   correction activity are visible. Record agent, task, worktree and start time,
   then read back the transition. An accepted prompt alone leaves the row Ready.
8. **Let owners advance bounded work.** An issue owner may dispatch the next
   bounded Ready slice, run cheap checks, route scoped REVIEW-AND-FIX work, and
   continue attributable fixture or harness corrections inside an authorized
   verification window without a fresh root handshake. The root arbitrates
   cross-owner conflicts and shared database capacity and retains acceptance,
   merge, GitHub and board-write authority. Owners report actual starts and
   evidence; Planner acceptance is not a readiness gate.

## Watching

Every cycle, the root alone reads the complete live board and all relevant
fields, including paginated items and fields, once and publishes the central
snapshot before anyone reads it. It then reads every in-flight agent terminal
with `orca terminal read`; check actual task activity, empty worktrees and
failed launches. This live-board verification is required even when no agent
has just finished; owners and workers reuse the snapshot rather than calling
GitHub.
The root reads each issue owner's terminal, and each owner reads its own
workers' terminals; nobody skips a level or starts a worker that already exists.
The interval between checks must never exceed twenty minutes, per the
20-minute rule in [agent coordination](agent-coordination.md#task-handoff).
The check reads what the agent actually did — its terminal, its diff, its
notes — and compares that against the brief. Telling a working agent apart
from a parked one is the hard part, and getting it wrong in either direction
is expensive.

Record each terminal handle, check time, observed action, comparison with the
brief and any steering sent. If progress appears stalled, use `orca terminal
send` to ask what it is waiting on and what it has completed, then read or wait
for its answer. Input acceptance alone does not prove the question was answered.
Never replace this interaction with host-process or cluster sampling, and never
stop an agent that has not failed to answer the question. Recover a failed
launch only after proving the prior session exited. Then verify the
replacement's actual task start and resolved model. Do not leave an idle agent,
orphan worktree or stale branch after its work has ended.

### GLM stale sweep

The historical GLM stale-sweep automation is disabled and not fixed. When
explicitly run as a bounded manual task, its observer writes `C:/Users/vijay/AppData/Local/Temp/vortex-fleet/stale-sweep.md` and sends
its summary to the root. The root forwards each finding to the owning
orchestrator and records that orchestrator's reply; it does not independently
mutate an owner's worktree. This observer does not replace terminal readback,
board reconciliation or proven-exit recovery. For a rescue finding, the owner
performs the porcelain-status inventory and complete-WIP commit or archive above;
the root preserves any existing rescue archive and holds new dispatch until the
rescue is deliberately recovered or closed.

Evidence that means something:

- A terminal-idle check returning idle while the task is unfinished.
- A heartbeat line the agent writes before and after every long command.
- Reads of its terminal showing the same error repeating, rather than
  distinct successive ones.
- A diff that touches files the brief did not authorise.

Evidence that lies:

- No host process running — database gates run inside Docker and are
  invisible to a process check.
- No verification cluster up — runs create and destroy them, so the gap
  between two is silent.
- A stale notes file — it only lags by however long the current step takes.
- A quiet transcript — an agent composing a long report shows nothing at all
  for minutes.

**Never stop an agent on inference.** Ask first: a message costs nothing and
reaches a running agent at its next tool round. Stop only when it fails to
answer.

| Signal | Orchestrator's move | Then |
| --- | --- | --- |
| Waiting on input | Read the terminal, answer if the answer is in the brief or the repo | Continue |
| Drifting — wrong files, scope creep | Send the scope and file list again | Re-check in 10 minutes |
| Retrying around a failure | Send the diagnosis, or dispatch Triage to reproduce it independently | Re-check in 10 minutes |
| Idle, unfinished, no answer | Stop the session; keep the worktree and its diff | Escalate |
| Two failed attempts | Escalate to Sol high; use Opus 5 high only for privileged database, security or concurrency work, re-dispatching with what was learned | Fresh worktree |
| Blocked on a real decision | Park the issue with a written question, pick up the next one | Queue moves on |

## Worktree cleanup

Done requires deleting merged issue branches locally and remotely where
applicable, stopping attached agents, and removing their worktrees after
preserving drafts and unmerged work. After a task branch is merged and its
board row is true, remove its finished worktree with `orca worktree rm
--worktree <exact-selector>`. Do this as part of completion; repeat the audit
on resume. A held hosted receipt does not require retaining a finished
developer's checkout.

First read the agent terminal to confirm completion, preserve reports and any
unsent drafts outside the disposable checkout without submitting them, inspect
every dirty diff, and confirm the work was committed and pushed or was
explicitly discarded with the root-recorded issue reason. Preserve partial and
untracked evidence until that decision. Before committing or removing the
worktree, use porcelain status including untracked files, report separate
tracked modified/deleted/staged and untracked counts, inspect those untracked
paths and explicitly add product files. A handoff must commit and push, or
archive, complete WIP including untracked migrations, runtime files and tests;
notes alone are insufficient. Preserve an existing rescue archive and suspend
new dispatch until it is deliberately recovered or closed, then verify the
branch's delivery in `main`. For squash merges verify the delivering PR and
patch, not just commit ancestry; a merged base alone never authorizes cleanup.
Record the removal and clear obsolete worktree references on the board. Do not
discard unmerged edits or stop a still-working agent to satisfy this cleanup.
Deliberately recover or close an orphan worktree; do not ignore it. Remove
unused analysis worktrees only after verifying they contain no unique work.
Keep only live-work checkouts, including the generic root's supervising
worktree; the canonical repository checkout is not a disposable agent worktree.

## Board

See [agent coordination](agent-coordination.md#board-and-dispatch-record) for
what each board status means and who owns it; this section does not restate
that. The fleet adds one standing cadence rule on top of it:

**After every agent finishes a task, the accountable issue owner reports to
the root. Before any other work, the root batches the board field changes and
confirms the changed row using the snapshot and root-confirmed evidence.** It
posts one closing comment citing the delivering pull request and evidence only
when whole-issue acceptance closes the issue. The board percentage is recounted
from the board itself rather than estimated. A finished task that is not on the
board is not finished.

Closure requires evidence, never source inspection: an issue closes when its
acceptance criteria are met by merged code and the local gates ran — not
because the code looks right.

## Gates

During a phase, local developer verification is the gate. Hosted
verification is a phase boundary, not a per-task step; see [Delivery
environments, database changes and testing](../specification/18-delivery-and-testing.md)
and the build plan's [planning rules](README.md#planning-rules) for the
current policy and the selective-verification mechanics.

Every task:

- `pnpm verify` (format, lint, typecheck, boundaries, tests, fixtures, build)
  run in the **foreground**.
- The database checks the change actually affects, each on a fresh
  verification cluster.
- Clean up with `pnpm db:clean` only — never `db:reset` or
  `supabase start|stop`.
- Independent review when the change touches security, privileged database
  objects or concurrency.

Every new proof:

- Registered in the verification manifest **and** assigned to a group in the
  selection inventory — an unassigned proof fails a hosted run closed, not
  open.
- Shown failing without the change, then passing with it.
- Built through the owning writer, never by direct insert.
- If the proof accompanies a migration, the migration is timestamped later
  than the newest migration already on `testing` — see the migration rule in
  the delivery specification.

## Hosted Kestra access

Hosted Testing evidence is read and controlled with `kestractl`, authenticated
to `https://kestra.abzum.com`, tenant `main`. Add `C:/home/abzum/.npm-global` to
`PATH` first, or use the authenticated absolute executable
`C:/home/abzum/.npm-global/kestractl.exe`. Before claiming authentication is
unavailable, also try the signed-in Orca embedded browser at that URL and tenant.
Never copy credentials or cookies into prompts or files. Never conclude that
hosted state is unobservable from an unauthenticated generic HTTP request; and
when a `kestractl` command fails, report its exact stderr.
Every issue owner relays these access and launch constraints to its workers and
includes them in future briefs. Access does not change the single mutation owner
or authorize duplicate executions.

- **Find the run.** `kestractl executions list --size 200 --output json`; keep
  entries whose `flowId` is `testing_database_delivery`, and order them by their
  top-level `startDate`, newest first.
- **Read the state.** `kestractl executions get <ID> --output json` gives the
  execution state.
- **Read a failure.** `kestractl logs list <ID> --min-level ERROR`. ERROR-level
  stderr can carry CLI notices, so the execution state and the assertions decide
  whether a run failed, not the mere presence of an ERROR line.
- **Before any promotion or trigger,** list and check for an in-flight run of the
  flow and for an existing run of the exact candidate revision. Hosted-run
  admission is separate from agent dispatch; never trigger a duplicate exact
  run. Read the outcome of every promotion once it lands.
- **Superseded runs.** `kestractl executions kill <ID>` is only for a run that a
  newer promotion has superseded. Never kill a run that is still the entitled
  Testing execution.

Only dev and staging executions are authorized. Production is unwanted, not a
pending approval: never approve, restart, or release Production; never rename a
Production destination to staging, or restart the Kestra server as a queue
workaround. #489 is the sole current Production-queue cleanup owner. It disables
Production admissions before cancelling verified obsolete queued Production
executions, then cancels obsolete paused Production executions; it records exact
before/after IDs and counts, verifies the actual destination behind Testing
naming, preserves dev/staging work and successful receipts, and does not create
a duplicate run. This does not clear any unrelated product-decision hold.

## Branch and promotion model

A task's branch is cut from `origin/main` and, once gates and review pass,
merges by pull request back into `main`. Task-level delivery can end there, but
an issue reaches Done only after its accepted evidence, local gates, true board
row, closure work, and any hosted receipt required by the applicable phase gate.

At a phase boundary, a promotion pull request merges `main` into `testing`,
and the hosted Kestra verification runs against that `testing` revision. Work
that has reached `main` but not `testing` is delivered but not hosted-verified;
the board must never blur the two. A migration that re-establishes a baseline
is promoted on its own, with nothing else bundled.

Check divergence at the start of any cycle that touches hosted results:

```
git rev-list --count origin/testing..origin/main
```

A non-zero count means `testing` is behind and every hosted result is testing
older code. A repaired concurrency proof once sat on `main` for six days while
every hosted run re-tested the broken copy on `testing` and failed identically.
Nothing reported it. A failed promotion becomes a new bug issue and returns to
the queue rather than blocking the branch.

> **Known contradiction.** [Branch flow](../specification/18-delivery-and-testing.md#branch-flow)
> in the specification still describes the earlier model — feature branches
> merging into `testing`, with the verified `testing` revision promoted to
> `main`. Delivery has run the other way round since at least September 2026:
> every feature pull request bases on `main`, and promotions base on `testing`.
> This document records what actually happens. Which model the project keeps is
> tracked separately and is not the orchestrator's decision to make.

### Predict verification before every promotion

Every promotion PR body must state **Expected verification: full** or
**Expected verification: selective**, with the reason, exact candidate and
Testing base. Inspect `git diff --name-only origin/testing..origin/main`, the
intervening path history and the reusable baseline, then compare with
`fullCoveragePatterns` in `workflows/kestra/database-verification-selection.json`
and the committed selector. Do not infer mode from the issue or PR label.

Existing SQL suites and concurrency proofs map to their exact registered check
and are subtracted from globally relevant inputs. The remaining protected
inputs force full coverage: `supabase/migrations/*.sql`, `supabase/config.toml`,
`supabase/seed.sql`, `supabase/tests/helpers/*`, `tooling/supabase/*`, and the
Kestra verification manifest, selection inventory, database-state snapshot,
delivery runner, selector and selector test. The inventory is authoritative
if this list changes. Missing, invalid or non-ancestor baseline evidence,
change-and-revert history and unmapped changed inputs also force full coverage.

A cheap selective run requires a valid successful ancestor baseline. After
failed runs have invalidated it, obtain one successful full run first; trying
to split protected changes cannot restore missing reuse evidence. The recovery
promotion containing #525/#526/#527 is explicitly a full baseline run because
#525 and #527 changed the delivery runner. Confirm #526 is merged and #523's
board row is true before that promotion. #525 runs lint immediately after
migrations, before SQL suites and concurrency, so schema errors fail early.

After the baseline is green, promote changes limited to existing suites/proofs
separately. Deliberately batch migrations and infrastructure into their own
full promotion. If selective is intended but a protected path is in the diff,
split before promoting; never bundle a migration into proof-only work intended
for selective verification. Compare the actual receipt mode and reasons to the
prediction. If a predicted selective run executes full coverage, record the
prediction defect explicitly and investigate before repeating it.

## Dispatch brief template

Every brief is drift-proof by construction: it names the objective, the
exact files in scope, the evidence required, and the things that will
otherwise go wrong. A vague brief costs an entire agent run.
Every brief and template, including an inline or owner brief, includes this
exact line: `Respond only in English.` Correct or replace an agent that responds
in another language. Every response is in English.

```
# Brief — <objective in one line>

Respond only in English.

You are not finished until your work is committed and pushed on a branch, or you have written on the issue why it is being discarded. Reaching the end of your analysis is not finishing.
Workers and owners supply evidence to the root; the root alone writes on the issue.

Read CLAUDE.md and docs/build-plan/agent-coordination.md first.
Setup: git fetch origin && git checkout -b <branch> origin/main

## Verify the premise FIRST
Confirm the defect still exists on your branch and that no fix exists on
another branch: git log --all --oneline -- <path>
If it is already fixed, STOP and report. Do not implement.

## The defect / the objective
<evidence: execution id, failing assertion, file:line>

## Scope
Touch exactly: <files>.  Do not touch: <files>.
Report defects in the code under test; never soften an assertion or add a
flag to product code to make a test pass.

## Evidence required
Show it failing without your change, then passing with it.
pnpm verify in the FOREGROUND. Affected db checks on a fresh cluster.

## Heartbeat
Append a timestamped line to <notes path> immediately before and after
every long command, so silence is interpretable.

## Hard rules
Queue for the fleet's maximum two concurrent pnpm db:* verification clusters;
this is not permission to dispatch · pnpm db:clean only · never db:reset or
supabase start|stop · never read .codex-tmp/ or .tmp/ · never print secrets
  · owners and workers make zero GitHub reads and no issue or board writes: read
  the shared snapshot and assigned dossier, and ask the root for missing context
  · commit and push the branch ·
open a PR only when explicitly briefed · no merge or issue edits.
```

The brief above is for a single-slice worker, which commits and pushes its
branch and may open a PR only when authorized. An issue owner's brief states
the whole outcome and its constraints, not a per-slice decomposition, and says
that the root supplies the dossier and that an owner may open a review PR only
when authorized. Owners report grouped proposed changes to the root; they do
not reconcile board records. For every agent, merging and promoting
are the root's decisions, made after the gates above pass — never the
dispatched agent's own.

The heartbeat line is not bureaucracy. Without it, a twenty-minute check
cannot tell a slightly-long gate from an agent waiting on a notification that
will never arrive: a subagent receives no completion notification for a
backgrounded command, so gates run in the foreground and agents read their
own output files.

## Autonomy boundaries

Autonomous does not mean unbounded. The orchestrator decides everything that
is an engineering judgement, and parks the few things that genuinely are
not — but parking never stops the queue: it writes the question on the
issue, sets the task aside, and picks up the next one.

Decides alone (the root, unless a bullet names the issue owner):

- Sequencing across issues, model choice, escalation, worktree lifecycle.
- Classifying an issue as whole-issue (multi-slice, needing an owner) or
  single-slice (a direct worker). The root does not keep per-slice
  decomposition.
- Issue owner: splitting a multi-slice issue whose scope is too broad to verify
  into its own slices, and planning them. The owner may use the Analysis lane for
  slice design.
- Raising a new issue for any defect a gate surfaces.
- Merging reviewed task branches to `main` once gates and review pass.
- Promoting `main` to `testing` at an eligible phase boundary, respecting user
  holds and recording the exact hosted result before claiming acceptance.
- Correcting board state, dependencies and stale plan documents.

Parks and moves on:

- Product decisions — what a capability should do for a user.
- Anything requiring a credential, or that would place a secret in a prompt,
  log or commit.
- Production deployment: Production is unwanted, not pending user approval.
  Only dev and staging executions are authorized; never approve, restart or
  release Production, rename it to staging, or restart Kestra as a workaround.
- Destructive action outside a worktree — shared stacks, remote state,
  history rewrites.
- Recovering rejected historical SQL from `.codex-tmp/` or `.tmp/` — never,
  under any framing.
- Weakening a check to make something pass.
