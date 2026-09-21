# Agent coordination

Approved by the user on 9 September 2026; routing was last reconciled on
21 September 2026. The latest direct user decisions override historical fleet
rules and historical handoff notes.
This governs engineering coordination, not product behaviour. It replaces an
earlier additional-review requirement for newly assigned work; historical review
receipts remain accurate.
Issue [#467](https://github.com/Abzum-NZ/Abzum-Vortex/issues/467) records the
stable dispatch and board-accountability rules below; it does not represent a
live delivery queue.

## Root model and launch pin (latest direct user rule)

The current root stays in the same session and Run as GPT-5.6 Sol low. Astra
is allowed only for architecture-level tasks, not routine coordination, coding
or routine review. Future root launches must explicitly use
`codex --model gpt-5.6-sol -c model_reasoning_effort="low"`; saved defaults are
insufficient because a higher-priority configuration can override them. Do not
restart the current root just to change defaults. Do not launch a second root.
Lower-cost Antigravity/OpenCode/Sonnet/Terra workers remain preferred.

## Latest cost-routing override (21 September 2026)

Reuse the existing issue owners and sole generic GPT-5.6 Sol low root. New routine work
uses available Gemini 3.8 Flash through Antigravity, GLM 5.3 through OpenCode,
or Claude Sonnet. Reserve new Sol assignments for genuinely complex analysis or
security review; Astra is restricted to architecture-level tasks. Historical Sol
owner/planner defaults
below do not authorize routine new Sol sessions. Preserve near-finished work and
partial edits at provider handoffs. Owners verify actual model, task/dispatch,
and started activity; accepted input is insufficient. Revalidate runtime handles
after a restart and keep board/card model and waiting-state labels truthful.

Disable recurring duplicate-supervisor launches; do not resume Production or
the paused delivery monitor. Root alone allocates the maximum two local DB slots,
with fresh grants after consumed invocations. Dispatch independent non-DB work
while gates run. Cleanup requires verified completion, clean tracked and untracked
state, merged/unneeded work and no active ownership; preserve all other work.

## Responsibilities

| Role | Work |
| --- | --- |
| Coordinator (generic root) | Select dependency-ready tasks, commission reviews, dispatch corrected handoffs, monitor drift/blockers and usage, maintain progress, own all GitHub and board access, perform acceptance, and coordinate delivery after normal checks. It has no implementation issue or pull-request ownership. |
| Planner (GPT 5.6 Sol) | Review and directly correct scope, acceptance, specification/build-plan wording and GitHub dependencies before developer handoff. |
| Developer | Execute a bounded approved plan, test the real behaviour, propose relevant documentation changes and return an exact reviewable commit. Do not merge or start another task without coordinator direction. |
| REVIEW-AND-FIX owner (Sonnet routine; Sol complex correctness/security; Opus privileged only) | After the original editor checkpoints and stops, take exclusive edit ownership of the preserved candidate, reproduce findings, implement scoped fixes, run affected checks, and return the exact diff or commit plus evidence in one bounded assignment. |
| Architecture Reviewer | Own explicitly assigned full-system reviews across code, specification, build plan and GitHub task architecture, plus genuinely complex architecture, cross-system design and task decomposition. Claude Opus is reserved for privileged database, security or concurrency review. Choose the simplest sufficient design. Do not use for routine work or implementation unless explicitly reassigned. |
| Hosted Tester | Run the single entitled Testing execution, record its receipt and result, and never start a duplicate run while the original is live. |
| User | Decide unresolved business/product behaviour. Engineering choices do not require a new user approval gate. |

Use these role names with the actual model in visible assignments, following
the naming format under Task handoff. Display names do not rename or replace
immutable canonical task references. Also record the resolved model, session
identifier and canonical task reference as execution metadata at handoff.

GPT-5.6 Sol low is the generic main fleet orchestrator. Keep existing issue
owners and planners; do not launch routine new Sol workers. Astra is allowed
only for explicitly scoped architecture-level tasks, never routine coordination,
coding or review. Existing mismatches transition only at a safe handoff
boundary, preserving work and evidence; board records retain the actual model
until the replacement's task activity is verified.

The permitted non-privileged execution lanes are GLM 5.3, Gemini 3.8
Flash, Claude Sonnet 5, GPT 5.6 Terra, GPT 5.6 Luna and GPT 5.6 Sol; Sol owns
issue planning and deep analysis, and Luna is permitted for mechanical work.
Route bounded contracts, fixtures, documentation, evidence and mechanical work
to Gemini or GLM where available; use Terra or Sonnet for bounded coding and
Opus or Sol for complex authorization or SQL/security-sensitive review. Cost is
measured by successful delivery. Claude's reset is confirmed: the next useful
bounded dispatch verifies actual availability, never a synthetic test. Record
the observed task activity, resolved model and session evidence. Verify terminal
readiness and resolved model before the initial brief, then verify actual task
activity after it. GLM capacity requires the same verification. Do not retry a
launch in a loop: retain a demonstrated failure and reassign once or report it.

GPT workers run through Codex's native worker mechanism. Do not substitute an
external CLI or another provider for a GPT worker. DeepSeek, when explicitly
chosen for a bounded task, is an external CLI worker only: its invocation,
canonical task reference and returned evidence must be recorded like any other
handoff. It is not evidence that a native GPT worker has been launched.

The Architecture Reviewer handles explicitly assigned full-system reviews.
The Planner assesses findings and directly corrects agreed specifications,
plans, tasks and dependencies before the Coordinator dispatches bounded
implementation. The REVIEW-AND-FIX owner receives the checkpointed candidate
after the original editor stops, then reviews and repairs it without returning
routine findings to that editor. Historical review receipts remain valid. This
does not authorize simultaneous conflicting edits or duplicate reviews.

The [GitHub project](https://github.com/orgs/Abzum-NZ/projects/2/views/1) remains
the task board. Issues hold scope, acceptance, dependencies and status. Existing
task-plan documents hold material design reasoning. Pull requests hold changes
and review results. The generic root is the sole GitHub reader and issue/board
mutation owner. Owners and workers make zero GitHub reads and no issue or board
writes; they may push a branch and open a pull request only when explicitly
briefed. Do not build another coordination service or duplicate the board.

Keep the issue description current: replace or remove obsolete or irrelevant
scope instead of preserving it under corrective comments. Retain applicable
requirements and dependencies. Use comments for review evidence and progress,
not as a substitute for a clear current description.

## Board and dispatch record

The board is the delivery record, not a list of intentions. At the start of each
30-minute root cycle, the root makes the one complete board read, including
paginated items and relevant fields, and publishes the timestamped snapshot and
issue dossiers for owners and workers to consume. Do not infer an empty queue,
a dependency state, a current owner or available capacity from a partial board
view. No owner or worker refreshes the board or an issue: missing or fresher
context is requested from the root.

Moving an issue into an active status does not itself launch work. The
coordinator must confirm actual implementation or correction activity and record
the canonical worker, task, model and evidence. A session, owner, unfinished
slice, or accepted text handoff is not active work. **Ready** means the scope is
executable and its dependencies are satisfied; no Planner acceptance gate is
required. **Backlog** means unselected or deferred work. When no Blocked status
exists, dependency-blocked work stays Backlog and names the exact blocker and
next responsible owner.

At every spawn, handoff and status transition, the root updates the board
together with the issue status: current owner, canonical worker/task reference,
started or finished UTC time as applicable, measured active time when available,
current evidence, and the next accountable owner. If a launch fails, keep the
issue Backlog, record the demonstrated reason, and select other dependency-ready
work; do not leave it marked active. When a worker finishes or is stopped,
record its result before assigning the next owner. These are stable operating
rules, not a live queue or a claim that a particular worker is currently
available.

Issue owners may dispatch the next bounded Ready slice, run cheap checks, route
scoped REVIEW-AND-FIX work, and continue attributable fixture or harness fixes
inside an authorized verification window without a fresh root handshake. The
root arbitrates cross-owner conflicts and shared database capacity, and retains
acceptance, merge, GitHub and board-write authority. Owners report actual starts
and evidence to the root; they do not wait for a Planner acceptance ceremony.

### Status meaning

Use each active board status for one accountable stage. **In progress** means a
verified Developer or REVIEW-AND-FIX owner is actively implementing or
correcting the current slice. **In review** means an actual review is currently
running. **Testing** means a verification run has actually started and remains
active. Queued review or verification is Ready with its exact next action, or
Backlog with its real dependency blocker. A partly completed parent with no
active slice is Ready or dependency-blocked Backlog, never perpetual In
progress. **Done** requires accepted evidence, applicable gates, required hosted
receipts, a true board row, and closure work.

This definition avoids inventing a second pre-Testing status while keeping
reviewer and Coordinator ownership truthful.

## Task handoff

Every in-flight card must have an accepted owner whose current activity is
verified from the native registry and task evidence, or the verified process and
session evidence for the permitted DeepSeek CLI worker. Match the card's displayed
assignment and exact task reference to that worker. A completed reviewer is not
an active owner: hand off to an active delivery owner or return awaiting work to
Backlog. Record `/root` in Dispatch reference when the active coordinator owns
delivery; keep its displayed owner in the same role/model/issue format and do
not count it as a child agent.

Use `Role (Model Name) - #issue - short description` for each assigned agent's
display name and the board's Current owner. The model must be the model actually
running that task. Record its exact native task reference (or the permitted
DeepSeek session reference) in Dispatch reference. Existing immutable task names
are retained; never claim that an existing agent was renamed. Record each role
separately when an agent serves more than one issue. Clear the active owner when
the work finishes and no next owner has accepted.

### Completion to next action

A settled result is a same-turn routing boundary, not a stopping point. Before
the coordinator ends that turn, it must make and record the engineering
acceptance or delivery disposition, verify one bounded next dispatch, or record
a precise dependency blocker with its accountable owner and unblock event. A
status update, vague “root approval pending”, or idle owner does not satisfy
this obligation. Drain executable Ready handoffs through existing owners and
worktrees before starting another supervisor or ending the turn.

The root retains merge, acceptance, GitHub and board authority, but makes the
decision from supplied evidence instead of postponing it. Owners prepare
evidence, repair attributable defects and run affected checks. A failed or timed
out gate gets an attributable diagnosis and affected proof. Never replay an
unchanged full suite blindly; a bounded affected rerun is permitted when it
tests a recorded intermittent-failure hypothesis.

Respond to questions from the coordinating agent in the other chat before
routine task work. Give verified answers, then resume the assigned task; a
message requesting a correction is not evidence that the correction is done.

The accountable owner supplies the issue, exact base revision, working directory,
branch, role, functional outcome, included/excluded work, relevant references,
required checks and stopping point. Each session verifies these before acting.
Use separate architecture, development and REVIEW-AND-FIX sessions with
explicit model selection; record the resolved model, session identifier and
actual task evidence. The original editor checkpoints and stops before the
REVIEW-AND-FIX owner receives exclusive edit ownership of the same preserved
candidate. Use Sonnet for routine work and Sol for genuinely complex correctness
or security repair; reserve Astra for architecture-level tasks. Because the
reviewer becomes an author, call the result reviewed-and-fixed rather than an
independent approval. Use a lightweight independent delta check only for a
security-sensitive or material logic change, without starting another full
review loop. Report an unavailable or changed model unless the current cost
routing above authorizes the named replacement.

One developer writes a task worktree at a time. Independent concurrent tasks use
separate worktrees. Never run competing dependency installations or edits in one
working copy. Preserve unrelated user changes. Review the submitted commit; if
it changes, review the affected differences and rerun relevant checks rather than
repeating unrelated completed reviews.

Database verification uses owner reservation windows rather than per-attempt
approval. One window permits up to three attempts or 30 minutes elapsed from
its recorded start, whichever comes first, while the fleet-wide maximum remains
two concurrent database clusters. Within that window, the owner or exclusive
REVIEW-AND-FIX owner may fix an attributable fixture or harness defect and rerun
only after an actual diff. Each attempt records unique identity, ready time,
start delay, timing, result, and cleanup. Stop on an unchanged failure,
product-scope change, ambiguous cleanup, or exhausted attempt/time budget. Never
blindly replay a command.

Before rerunning, audit the full fixture setup, role, request-context, and TAP
transitions against known-good patterns, then run cheap executable lint,
typecheck, and focused tests. The reviewer fixes scoped findings directly. Use a
lightweight independent delta check only for security-sensitive or material
logic changes.

Run independent ready work in parallel on available Gemini 3.8 Flash, OpenCode
GLM 5.3, Sonnet, or Terra lanes. Do not repeatedly probe a provider already
known to be exhausted. Reserve Sol for complex correctness or security repairs
and Astra for architecture-level work. Every in-flight card states the actual
waiting blocker and next responsible agent. Duplicate supervision stays
disabled; use existing board and dossier timestamps to monitor ready-to-start
delay, attempts, and failures without adding an observability platform.

Observe live progress. Repeated searches, retries or rewrites without new evidence
require intervention: clarify the task, resolve a demonstrated blocker or reassign
it. Do not restart a live session solely because an observation timed out.
If a subagent remains active for more than 20 minutes, inspect its transcript
and current work before continuing or replacing it; use that evidence to decide
whether it is progressing, blocked or drifting. Do not presume a capacity
blocker. State one only when the native dispatch mechanism returns concrete
capacity evidence. Do not work around a missing or unavailable native GPT
worker by starting an external GPT session.
Before every assignment, inspect Orca's live status-bar usage roster and record
the observation timestamp and available headroom as execution metadata. Prefer
an available lane and never queue behind an exhausted model; observed usage is
live, not a fixed percentage to copy into a rule. Apply the checkpoint, safe
handoff and privileged-Opus-unavailability procedure in [agent fleet
operations](agent-fleet.md#roster-and-model-assignment). Reserve the full-system
Architecture Reviewer for its complex responsibilities and scope broad reviews
into coherent passes. If a limit is exhausted, stop retries and do not create
duplicate sessions; use the current cost-routing reassignment where it fits,
otherwise record the reset/blocker.

## Scope and communication rules

- Respond only in English in every brief, terminal prompt, handoff and response.
- State the functional outcome and concrete facts. Avoid theatrical claims such
  as "bulletproof", "catastrophic", "constitution" or "fully complete" without
  evidence. Do not narrate confidence as proof.
- Distinguish implemented, tested locally, deployed, hosted-verified and unfinished.
  Cite file paths, test results and commit/PR links. A pure fixture is not a live
  database proof; a preview build is not hosted database verification.
- Fix the demonstrated cause using existing services and contracts. Before adding
  a framework, counter, fingerprint, fallback, guard or approval process, identify
  the concrete failure that existing transactions/revisions cannot address.
- Treat the repository, database schema and supporting configuration as active
  development work. When the cause is in an engine, contract or schema, correct it
  there rather than preserving an unsuitable shape with wrappers or compatibility
  layers. Keep compatibility only where a published product behaviour genuinely
  relies on it. The Planner applies this rule when correcting the handoff before
  developers receive it; required access and data-integrity rules remain part
  of the owning engine's contract.
- No unrelated refactoring, dependency upgrades, infrastructure work, visual
  designer work or extra features. Discuss a necessary scope expansion with the
  coordinator before implementing it. Discovery alone does not authorize it.
- Keep the core application-agnostic. Fixture applications are test inputs, never
  special cases inside engines. Preserve exact field semantics and normal access
  controls across browser, import, flow and MCP consumers.
- Verify changed behaviour and relevant regressions in proportion to risk. Avoid
  repetitive tests of the same fact. Never remove isolation, permission or
  concurrency requirements to simplify passing tests.
- Business ambiguity: ask the coordinator, who asks the user only when needed.
  Technical dependency: identify it and continue independent assigned work.
  Low-priority maintenance: recommend backlog. Engineering detail: architect
  decides, documents material reasoning, the Planner corrects the handoff, the
  Developer implements and the REVIEW-AND-FIX owner reviews and repairs.
- Prior safety denials remain binding across tools and agents. Do not recover a
  rejected patch from an older worktree or execute it through another agent as a workaround.
  Do not add global wildcard permission rules, copy credentials, broadly reset,
  or silently deploy. A custom `agy` command must explicitly include the
  user-selected `--dangerously-skip-permissions` flag; this narrow command
  requirement does not authorize a new global permission rule. Existing
  OpenCode allow configuration remains user-owned and is not edited by agents.
- Before claiming hosted authentication is unavailable, try
  `C:/home/abzum/.npm-global/kestractl.exe` (or add that directory to `PATH`) and
  the signed-in Orca embedded browser at `https://kestra.abzum.com`, tenant
  `main`. Never copy credentials or cookies into prompts or files. Access does
  not authorize a duplicate execution, a second mutation owner, or any
  Production action.

## Completion handoff

Return: changed functionality; files/commit; tests actually run and results;
remaining acceptance gaps; necessary spec/plan/task updates; and any real blocker.
The REVIEW-AND-FIX owner, in a separate session after the original editor stops,
reviews the preserved patch against the issue and approved product model,
reproduces findings, implements scoped fixes, and runs affected checks. It
returns the exact diff or commit, evidence, and remaining acceptance gaps in one
bounded assignment. Product choices and scope expansion return to the
Coordinator. For trivial fixture corrections, the Coordinator may authorize a
bounded verification budget that persists across sequential corrections within
the two-cluster cap; each invocation still records unique allocation and cleanup
evidence. Because this owner authors the correction, its output is
reviewed-and-fixed, not independent approval. Security-sensitive or material
logic changes receive a lightweight independent delta check rather than another
full review loop. Privileged database, security or concurrency changes also
receive the privileged handling required by the fleet rules. The Coordinator
merges only after applicable checks pass. Existing independent approval is
reused for unchanged work.

User reports use Completed, Coming up, Pending User Decision and Overall Progress
rows, with linked tasks and functional descriptions. Overall Progress counts all
board items, including epics, and states the numerator/denominator. Do not claim
product readiness from task completion.

## Tooling

Use Claude Code's existing model selection, programmatic sessions and worktrees:
[models](https://code.claude.com/docs/en/model-config),
[programmatic execution](https://code.claude.com/docs/en/headless),
[worktrees](https://code.claude.com/docs/en/worktrees).
Authentication and billing authorization belong in Claude's own interface, not
repository files. The coordinator keeps deployment credentials and board mutation
authority out of developer prompts unless explicitly needed for the assigned work.

## Autonomous fleet operation

When this project runs as an unattended agent fleet inside Orca, one generic
GPT-5.6 Sol low root orchestrator carries out the Coordinator's dispatch,
GitHub/board, acceptance and monitoring duties. A GPT-5.6 Sol Planner carries
out handoff correction for each task, and every multi-slice issue has a GPT-5.6
Sol issue owner that supervises its workers; there is no owner or worker cap apart from the two
concurrent `pnpm db:*` verification clusters.
[Agent fleet operations](agent-fleet.md) is the operational reference for that
mode: the model roster, the escalation ladder, queue ordering, the
twenty-minute watch, the verification gates, the branch and promotion model,
and the dispatch brief template. It does not restate the roles, board
statuses or completion handoff defined above, and nothing in it overrides them.

The orchestrator decides sequencing, model choice, escalation and worktree
lifecycle; splits an issue whose scope is too broad to verify; raises a new
issue for any defect a gate surfaces; merges reviewed task branches once
gates and review pass; promotes a verified revision to `main` at a phase
boundary; and corrects board state, dependencies and stale plan documents. It
parks, without stopping the queue, genuine product decisions, anything
needing a credential or that would place a secret in a prompt, log or commit,
Production deployment, destructive action outside a worktree, and any attempt
to weaken a check to make something pass. Production is unwanted: only dev
and staging executions are authorized; never approve, restart or release
Production, rename it to staging, or restart the Kestra server as a workaround.
See [Agent fleet
operations](agent-fleet.md#autonomy-boundaries) for the complete list.
