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

## Responsibilities

| Role | Work |
| --- | --- |
| Coordinator (generic root) | Select dependency-ready tasks, commission reviews, dispatch corrected handoffs, monitor drift/blockers and usage, maintain progress, own all GitHub and board access, perform acceptance, and coordinate delivery after normal checks. It has no implementation issue or pull-request ownership. |
| Planner (GPT 5.6 Sol) | Review and directly correct scope, acceptance, specification/build-plan wording and GitHub dependencies before developer handoff. |
| Developer | Execute a bounded approved plan, test the real behaviour, propose relevant documentation changes and return an exact reviewable commit. Do not merge or start another task without coordinator direction. |
| Independent Reviewer (GPT 5.6 Sol; Claude Opus only for privileged work) | In a separate session, verify the implementation against the issue and approved product model, inspect actual evidence, and record findings or approval independently of the Developer. |
| Architecture Reviewer | Own explicitly assigned full-system reviews across code, specification, build plan and GitHub task architecture, plus genuinely complex architecture, cross-system design and task decomposition. Claude Opus is reserved for privileged database, security or concurrency review. Choose the simplest sufficient design. Do not use for routine work or implementation unless explicitly reassigned. |
| Hosted Tester | Run the single entitled Testing execution, record its receipt and result, and never start a duplicate run while the original is live. |
| User | Decide unresolved business/product behaviour. Engineering choices do not require a new user approval gate. |

Use these role names with the actual model in visible assignments, following
the naming format under Task handoff. Display names do not rename or replace
immutable canonical task references. Also record the resolved model, session
identifier and canonical task reference as execution metadata at handoff.

GPT-6 Astra (Medium) is reserved exclusively for the one generic main fleet
orchestrator. Every issue owner, issue-level orchestrator and Planner is GPT
5.6 Sol. Do not launch Astra children, including Planner or Independent
Reviewer children. Existing mismatches transition only at a safe handoff
boundary, preserving work and evidence; board records retain the actual model
until the replacement's task activity is verified.

The permitted non-privileged execution lanes are GLM 5.3 Flash, Gemini 3.8
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
implementation. The Independent Reviewer verifies the resulting work.
Historical review receipts remain valid. This does not authorize simultaneous
conflicting edits or duplicate reviews.

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
coordinator must first launch or explicitly hand off the task, confirm the
recipient accepted it, and record the actual canonical worker/task name—not a
planned role—in the issue's board record. A text-only assignment is planned
work, not active work: keep it Backlog. Ready is reserved for work whose named
GPT-5.6 Sol Planner has accepted the planning handoff; record its resolved model
and session evidence.

At every spawn, handoff and status transition, the root updates the board
together with the issue status: current owner, canonical worker/task reference,
started or finished UTC time as applicable, measured active time when available,
current evidence, and the next accountable owner. If a launch fails, keep the
issue Backlog, record the demonstrated reason, and select other dependency-ready
work; do not leave it marked active. When a worker finishes or is stopped,
record its result before assigning the next owner. These are stable operating
rules, not a live queue or a claim that a particular worker is currently
available.

### Status meaning

Use each active board status for one accountable stage. **In progress** means
an accepted Developer, Planner, or Reviewer is changing or investigating the
work. **In review** covers the bounded review-and-delivery gate: an Independent
Reviewer is active until issuing a verdict; after approval, the Coordinator may
remain the active owner while the same status waits for the normal pull-request
check and merge. The card must say explicitly which of those two states applies;
never imply that a completed reviewer is still active. **Testing** begins only
after the reviewed change is merged to Testing and the Hosted Tester owns the
one exact execution. **Done** requires accepted evidence, completed applicable
local gates, any required hosted receipt, a true board row, and closure work.
A merged branch or finished worker alone is not Done.

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

Respond to questions from the coordinating agent in the other chat before
routine task work. Give verified answers, then resume the assigned task; a
message requesting a correction is not evidence that the correction is done.

After the Planner reviews and corrects the task handoff, the Coordinator supplies the
issue, exact base revision, working directory,
branch, role, functional outcome, included/excluded work, relevant references,
required checks and stopping point. Each session verifies these before acting.
Use separate architecture, development and independent-review sessions with
explicit model selection; record the resolved model, session identifier and
actual task evidence. A reviewer must not review its own authoring session, but
need not be from a different model family. Report an unavailable or changed
model unless the current cost routing above authorizes the named replacement.

One developer writes a task worktree at a time. Independent concurrent tasks use
separate worktrees. Never run competing dependency installations or edits in one
working copy. Preserve unrelated user changes. Review the submitted commit; if
it changes, review the affected differences and rerun relevant checks rather than
repeating unrelated completed reviews.

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
  Developer implements and the Independent Reviewer verifies.
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
The Independent Reviewer, in a separate session, reviews the patch against the
issue and approved product model using actual evidence and corrects any planning
or acceptance errors before the Coordinator returns specific implementation
findings to the Developer. Privileged database, security or concurrency changes
also receive the privileged review required by the fleet rules. The Coordinator
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
GPT-6 Astra root orchestrator carries out the Coordinator's dispatch,
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
