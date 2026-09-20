# Agent fleet operations

Vortex development runs as an autonomous agent fleet inside Orca, an agent
development environment external to this repository. One orchestrator plans,
dispatches, watches and reports; implementer agents do the work in isolated
worktrees, one agent per terminal per worktree per branch. This document is
the operational reference for that fleet: the roster, the escalation ladder,
how the next task is chosen, how a running agent is checked, the gates a task
must pass, the branch and promotion model, the dispatch brief template, and
what the orchestrator decides alone versus parks.

Read [agent coordination](agent-coordination.md) first. It defines the
coordination roles, the board status meanings and the completion handoff that
apply to this work regardless of how a session is launched. This document
defines how the fleet runs those rules unattended, and does not restate them.

**The objective is delivered functionality.** Agents implement and verify real
behaviour. "Improve the tests" is never a task on its own, and a task that
turns into test maintenance instead of delivering the functionality it was
dispatched for has drifted from its brief.

## Topology

Orca's unit of work is the agent session: one CLI agent in one terminal in one
worktree. Each agent has its own disposable checkout to work in, and the
orchestrator can discard a branch without touching anyone else's work. Orca
launches every agent with its full-autonomy permission flag already applied
on that basis: the worktree is the sandbox. The orchestrator never edits
another agent's worktree; it steers by sending text into that agent's
terminal and by reading the terminal back.

## Roster and model assignment

Model choice follows the shape of the work, not seniority. Privileged
database objects and anything that can widen access get the most capable
reviewer available; mechanical, well-specified volume goes to the cheapest
agent that can do it correctly. Tune this mapping from outcomes rather than
treating it as fixed.

| Lane | Model | Does | Owns |
| --- | --- | --- | --- |
| Orchestrator | GPT 6 Astra · medium (Codex) | Plans, sequences, dispatches, watches, steers, escalates, merges, promotes and reports. Holds no implementation work of its own — if it starts writing code, the queue stops moving. | The board, the dependency order, worktree lifecycle, phase gates |
| Schema & security | Claude Opus 5 · high | Privileged database objects, migrations, row-level security, permission binding, concurrency writers — anything where a mistake widens access or corrupts a revision | `supabase/migrations/**`, access and record writers |
| Runtime & contracts | Claude Sonnet 5 · high | TypeScript engines, contracts, adapters and the definition-led execution path; escalates to the Schema & security lane the moment a change reaches into a privileged writer | `runtime/**`, `contracts/**` |
| Proofs | Claude Sonnet 5 · high | pgTAP suites and the two-session concurrency harness; builds every fixture through the owning writer, never by direct insert; reports defects rather than softening assertions | `supabase/tests/**` and verification registration |
| Workhorse | GLM 5.3 (OpenCode) | High-volume, well-specified, low-blast-radius work where the answer is checkable: plan-document sync, registration and inventory sweeps, scaffolds, evidence collection, dependency audits | `docs/**`, manifests, selectors, audits |
| Triage | GPT 5.6 Luna · low (Codex) | Cheap and fast: read an issue, reproduce a failure, scan logs, confirm a premise, summarise a diff. The first responder that stops expensive agents being dispatched on false premises | Pre-dispatch premise checks, failure triage |
| Analysis | GPT 5.6 Sol · high (Codex) | Root-cause work and slice design when a defect resists the obvious reading, or when an issue's scope needs splitting before anyone implements it | Diagnosis notes, slice proposals, spec deltas |
| Second lane | GPT 5.6 Terra · medium (Codex) | A balanced implementer for independent work when the Claude lanes are saturated, and the default author for changes that are broad but shallow | Overflow implementation |
| Reviewer | Claude Opus 5 · high, or GPT 6 Astra · medium | Independent review where the change touches security, privileged database objects or concurrency. Must be a different model family than the implementer — a model reviewing its own reasoning is not independent | Approve, reject, or name what is missing |

GPT lanes run through Codex's native worker mechanism; GLM runs through
OpenCode. Do not substitute an external CLI or another provider for a named
worker — [agent coordination](agent-coordination.md) governs how a resolved
model and session are recorded.

Use `--agent opencode` for documentation, manifests, inventories, dependency
audits and evidence gathering. Confirm GLM 5.3 in the launched terminal before
sending the brief. Record the terminal and observed model with the dispatch.
If OpenCode fails to launch, report and record the exact failure; do not silently
fall back to Claude. Apply the escalation ladder only with the failure evidence.

## Escalation ladder

The ladder is two rungs, not a staircase. A task that stalls or fails twice
while assigned to **GLM 5.3, GPT 5.6 Luna or GPT 5.6 Terra escalates directly
to GPT 6 Astra (medium) or Claude Opus 5 (high)** — nothing in between.
Escalating one model at a time re-runs the same failure at each intermediate
step instead of resolving it.

Escalation carries the failure forward: the new brief states what was already
tried and why it failed, so the stronger model does not repeat it. A task
that still fails at that top rung becomes an analysis task for Sol, not a
third implementation attempt.

## The dispatch loop

The orchestrator runs one loop, continuously, without waiting for a human.
Every pass through it either advances a task, parks it with a reason, or
raises a new issue. It stops only when the board has no startable work left.

1. **Select** — pick the next dependency-ready task; see Queue selection below.
2. **Brief** — verify the premise, then write a drift-proof brief; see Dispatch brief template below.
3. **Dispatch** — start one agent in one new worktree on one branch, in a single command, for example:

   ```
   orca worktree create --repo id:<repoId> --name <branch-name> \
     --agent claude --setup run --parent-worktree active \
     --prompt "$(cat brief.md)" --json
   ```

4. **Watch** — check the agent at least every twenty minutes; see Watching below.
5. **Gate** — run local verification and independent review where required; see Gates below.
6. **Land** — open the pull request into `main` and merge once gates and review pass. Promotion to `testing` remains a separate phase gate, subject to any user hold.
7. **Reconcile and report — blocking step.** Complete the board reconciliation below before selecting or dispatching another task. A task is not finished until its board row is true.
8. **Clean up.** Once the branch is merged and the board row is verified, remove
   the finished checkout with `orca worktree rm`; see Worktree cleanup below.

### Blocking completion and resume gate

After every worker completion, review verdict, merge, hosted result or closure,
and before the first dispatch after a resume:

1. Read the complete live board and its fields. Reconcile open issues against
   their PRs, actual branch ancestry, local gates, applicable hosted receipts and
   remaining acceptance. A merged slice is not automatically a completed issue.
2. Set the actual delivery stage. Use **In progress** only for accepted active
   work; **In review** for an open review/delivery PR or Coordinator-owned work
   merged to `main` but awaiting promotion. State that post-merge waiting stage
   explicitly; do not imply that a PR or reviewer is still active. Use **Testing**
   only when the work is actually on `testing` and awaiting its required receipt.
   Record a promotion/run hold without inventing an active Hosted Tester.
   Use **Done** and close the issue only when its acceptance is met, local gates
   ran and any required hosted evidence exists. Do not return fully implemented
   work to Backlog merely because its worker finished. Backlog may describe
   genuinely unstarted remaining scope after accepted slices, which must be
   named separately with their evidence.
3. Record the real owner, canonical dispatch reference, completion time, exact
   commit/PR, checks actually run and remaining acceptance or hold. Clear completed
   workers; name the next accountable owner. Post a completion comment citing the
   delivering PR and evidence, and a closing comment when acceptance is complete.
4. Re-read native dependencies, derive the pickup order for newly unblocked work,
   and post Completed, Coming up, Pending User Decision and Overall Progress rows.
   Recount the numerator and denominator from the live board.
5. Read back the changed board rows and issue states. **Do not dispatch the next
   worker until these writes are verified.** A failed or incomplete reconciliation
   blocks new dispatch, not an already running worker's authorized work.

On resume, repair stale rows before continuing the queue. A local checkpoint or
watchdog handoff is not a substitute for the GitHub board. Preserve user holds;
never promote merely to make a status label fit.

Two feedback paths run outside that sequence. A stall or drift caught while
watching can be steered, re-briefed, or escalated to a stronger model,
returning to Brief. A failed gate never blocks the loop: it becomes a new
tracked issue and re-enters Select on its own merits, rather than stopping
work behind it.

The orchestrator keeps itself alive between cycles with a scheduled prompt so
a crash or restart resumes the loop rather than ending it.

## Queue selection

Order comes from the repository, not from intuition. Issue numbers, folder
names and old comments are not evidence of sequence — native GitHub
dependencies are.

1. **Collect candidates.** Open issues whose board status is Ready or Backlog.
2. **Drop anything genuinely blocked.** Query each issue's blocking
   dependencies and confirm the response actually parsed before trusting an
   empty result — a failed call that returns nothing looks identical to no
   blockers, and trusting it has produced false "unblocked" verdicts.
   Paginate the `issues/{number}/dependencies/blocked_by` endpoint and count
   only edges whose issue `state` is `open`. Closed blockers remain in this
   endpoint: a nonempty response is not evidence of an open blocker. Retain
   closed edges as audit evidence, not exclusions. An unknown state or failed
   page leaves eligibility unknown until resolved. Re-run this filter across
   the whole board on resume and after completions, not just the old queue.
3. **Order by roadmap lane, then priority, then dependency depth.** Work that
   unblocks the most downstream issues goes first within a lane.
4. **Prefer functionality over maintenance.** Between two startable tasks,
   the one that delivers capability wins over the one that tidies coverage.
   A defect in a shipped writer is functionality; adding tests around a
   working one is not — this is the same rule that makes test maintenance an
   invalid task on its own.
5. **Respect the concurrency caps.** At most two database-cluster
   verification tasks in flight at once, four agents in flight in total.
   Running more has produced clock skew across parallel verification
   clusters and failed unrelated time-dependent proofs.
6. **Verify the premise before briefing.** Search the full commit history for
   the affected path and search closed issues. A fix that already exists on
   another branch is the single most expensive thing to re-implement.
7. **Dispatch, and record the dispatch on the board** — status, agent, model,
   worktree, started-at.

## Watching

Every cycle, read every in-flight agent's terminal with `orca terminal read`.
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
stop an agent that has not failed to answer the question.

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
| Two failed attempts | Escalate straight to Astra medium or Opus 5 high, re-dispatching with what was learned | Fresh worktree |
| Blocked on a real decision | Park the issue with a written question, pick up the next one | Queue moves on |

## Worktree cleanup

After a task branch is merged and its board row is true, remove its finished
worktree with `orca worktree rm --worktree <exact-selector>`. Do this as part
of completion, before the next dispatch; repeat the audit on resume. A held
hosted receipt does not require retaining a finished developer's checkout.

First read the agent terminal to confirm completion, preserve reports and any
unsent drafts outside the disposable checkout without submitting them, check
for uncommitted work, and verify the branch's delivery in `main`. For squash
merges verify the delivering PR and patch, not just commit ancestry. Record
the removal and clear obsolete worktree references on the board. Do not
discard unmerged edits or stop a still-working agent to satisfy this cleanup.
Remove unused analysis worktrees after verifying they contain no unique work.
Keep only live-work checkouts, including the active coordinator; the canonical
repository checkout is not a disposable agent worktree.

## Board

See [agent coordination](agent-coordination.md#board-and-dispatch-record) for
what each board status means and who owns it; this section does not restate
that. The fleet adds one standing cadence rule on top of it:

**After every agent finishes a task, the orchestrator updates the board —
status, evidence comment and a re-derived pickup order — before it dispatches
the next one.** The closing comment cites the delivering pull request and the
evidence (test counts, reviewer, file:line citations), and the board
percentage is recounted from the board itself rather than estimated. A
finished task that is not on the board is not finished.

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

## Branch and promotion model

A task's branch is cut from `origin/main` and, once gates and review pass,
merges by pull request back into `main`. That is where task-level delivery
ends under the phase-gate policy above — a task does not wait for a hosted run
to reach Done.

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

```
# Brief — <objective in one line>

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
One verification cluster at a time · pnpm db:clean only · never db:reset or
supabase start|stop · never read .codex-tmp/ or .tmp/ · never print secrets
· commit and push the branch · no PR, no merge, no issue edits.
```

The dispatched agent commits and pushes its branch only. Opening the pull
request, merging and promoting are the orchestrator's decisions, made after
the gates above pass — never the dispatched agent's own.

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

Decides alone:

- Sequencing, model choice, escalation, worktree lifecycle.
- Splitting an issue whose scope is too broad to verify.
- Raising a new issue for any defect a gate surfaces.
- Merging reviewed task branches to `main` once gates and review pass.
- Promoting `main` to `testing` at an eligible phase boundary, respecting user
  holds and recording the exact hosted result before claiming acceptance.
- Correcting board state, dependencies and stale plan documents.

Parks and moves on:

- Product decisions — what a capability should do for a user.
- Anything requiring a credential, or that would place a secret in a prompt,
  log or commit.
- Production deployment, which stays parked until final delivery.
- Destructive action outside a worktree — shared stacks, remote state,
  history rewrites.
- Recovering rejected historical SQL from `.codex-tmp/` or `.tmp/` — never,
  under any framing.
- Weakening a check to make something pass.
