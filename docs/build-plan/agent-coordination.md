# Agent coordination

Approved by the user on 9 September 2026; routing updated on 12 September 2026.
This governs engineering coordination, not product behaviour. It replaces an
earlier additional-review requirement for newly assigned work; historical review
receipts remain accurate.
Issue [#467](https://github.com/Abzum-NZ/Abzum-Vortex/issues/467) records the
stable dispatch and board-accountability rules below; it does not represent a
live delivery queue.

## Responsibilities

| Role | Work |
| --- | --- |
| Coordinator | Select dependency-ready tasks, commission reviews, dispatch corrected handoffs, monitor drift/blockers and usage, maintain progress, and coordinate delivery after normal checks. |
| Planner | Review and directly correct scope, acceptance, specification/build-plan wording and GitHub dependencies before developer handoff. |
| Developer | Execute a bounded approved plan, test the real behaviour, propose relevant documentation changes and return an exact reviewable commit. Do not merge or start another task without coordinator direction. |
| Independent Reviewer | Verify the implementation against the issue and approved product model, and record findings or approval independently of the Developer. |
| Architecture Reviewer | Own explicitly assigned full-system reviews across code, specification, build plan and GitHub task architecture, plus genuinely complex architecture, cross-system design and task decomposition. Choose the simplest sufficient design. Do not use for routine work or implementation unless explicitly reassigned. |
| Hosted Tester | Run the single entitled Testing execution, record its receipt and result, and never start a duplicate run while the original is live. |
| User | Decide unresolved business/product behaviour. Engineering choices do not require a new user approval gate. |

Use these role names with the actual model in visible assignments, following
the naming format under Task handoff. Display names do not rename or replace
immutable canonical task references. Also record the resolved model, session
identifier and canonical task reference as execution metadata at handoff.

The current direct user requirement assigns GPT-6 Astra (Medium) to both the
Planner and Independent Reviewer roles. Include that model alongside the role
in visible assignments and record it in each handoff's execution metadata.

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
and review results. Do not build another coordination service or duplicate board.

Keep the issue description current: replace or remove obsolete or irrelevant
scope instead of preserving it under corrective comments. Retain applicable
requirements and dependencies. Use comments for review evidence and progress,
not as a substitute for a clear current description.

## Board and dispatch record

The board is the delivery record, not a list of intentions. Before assigning,
sequencing or reporting work, read every project item and every relevant field,
including paginated results beyond the first 30 items and beyond the first 30
fields. Do not infer an empty queue, a dependency state, a current owner or
available capacity from a partial board view.

Moving an issue into an active status does not itself launch work. The
coordinator must first launch or explicitly hand off the task, confirm the
recipient accepted it, and record the actual canonical worker/task name—not a
planned role—in the issue's board record. A text-only assignment is planned
work, not active work: keep it Backlog. Ready is reserved for work whose named
Planner has accepted the planning handoff; record the required GPT-6 Astra
(Medium) model in that handoff's execution metadata.

At every spawn, handoff and status transition, update the board together with
the issue status: current owner, canonical worker/task reference, started or
finished UTC time as applicable, measured active time when available, current
evidence, and the next accountable owner. If a launch fails, keep the issue
Backlog, record the demonstrated reason, and select other dependency-ready
work; do not leave it marked active. When a worker finishes or is stopped,
record its result before assigning the next owner. These are stable operating
rules, not a live queue or a claim that a particular worker is currently
available.

## Task handoff

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
Use separate architecture and development sessions with explicit model selection;
record the resolved model and session identifier. Report an unavailable or changed
model instead of silently substituting one.

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
Track session and model-specific usage as execution metadata. Reserve the
full-system Architecture Reviewer for its complex responsibilities and scope
broad reviews into coherent passes. If a limit is exhausted, stop retries, wait
for the stated reset, then resume the already assigned work without creating
duplicate sessions.

## Scope and communication rules

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
  No permission-bypass mode, credential copying, broad reset or silent deployment.

## Completion handoff

Return: changed functionality; files/commit; tests actually run and results;
remaining acceptance gaps; necessary spec/plan/task updates; and any real blocker.
The Independent Reviewer reviews the patch against the issue and approved
product model and corrects any planning or acceptance errors before the
Coordinator returns specific implementation findings to the Developer. The
Coordinator merges only after applicable checks pass. Existing independent
approval is reused for unchanged work.

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
