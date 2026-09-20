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
6. **Land** — open the pull request and merge to `testing` once gates and review pass.
7. **Report** — update the board (status, evidence, re-derived pickup order) before selecting the next task.

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

Every in-flight agent is checked at least every twenty minutes, per the
20-minute rule in [agent coordination](agent-coordination.md#task-handoff).
The check reads what the agent actually did — its terminal, its diff, its
notes — and compares that against the brief. Telling a working agent apart
from a parked one is the hard part, and getting it wrong in either direction
is expensive.

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
merges by pull request into `testing`. That is where nearly all task-level
delivery ends under the phase-gate policy above — a task does not wait for a
hosted run to reach Done.

At a phase boundary, the orchestrator confirms the accumulated `testing`
revision, the phase's hosted Kestra verification runs there once, and — once
that revision is verified — a promotion pull request merges `testing` into
`main`. See [Branch flow](../specification/18-delivery-and-testing.md#branch-flow)
for the authoritative sequence and the break-glass exception.

Check for unexpected divergence between the two branches at the start of any
cycle that touches hosted results. `origin/testing..origin/main` should be
empty outside a recorded break-glass exception, since nothing should reach
`main` except through a verified promotion; a growing
`origin/main..origin/testing` gap is the normal, expected shape of an
in-progress phase, but should not be left to grow indefinitely. A failed
promotion becomes a new bug issue and returns to the queue rather than
blocking the branch.

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
- Merging reviewed task branches to `testing` once gates and review pass.
- Promoting the verified `testing` revision to `main` at a phase boundary,
  after reading the hosted result.
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
