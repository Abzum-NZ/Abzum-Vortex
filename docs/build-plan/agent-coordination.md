# Agent coordination

Approved by the user on 9 September 2026. This governs engineering coordination,
not product behaviour. It replaces earlier requirements for an additional Sol
review on newly assigned work; historical review receipts remain accurate.

## Responsibilities

| Owner             | Work                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex coordinator | Select dependency-ready tasks; rewrite clear scope and acceptance; commission architecture; independently review actual implementation; maintain GitHub and verify specification/build-plan synchronization; merge after normal checks. |
| Claude Fable 5.1  | Own every full-system review across code, specification, build plan and GitHub task architecture, plus genuinely complex architecture, cross-system design and task decomposition. Choose the simplest sufficient design. Do not use for routine work or implement unless explicitly reassigned. |
| Claude Opus 5     | Implement the assigned plan, test the real behaviour, propose relevant documentation changes and return an exact reviewable commit. Do not merge or start another task without coordinator direction.                                   |
| Claude Sonnet 5   | Handle bounded intermediate implementation, focused analysis and well-specified follow-up work. Escalate architectural ambiguity instead of expanding scope.                                                                             |
| User              | Decide unresolved business/product behaviour. Engineering choices do not require a new user approval gate.                                                                                                                              |

After the current compatibility task, Fable 5.1 reviews the full codebase,
specification and GitHub issues. Codex assesses findings; Fable 5 then updates
agreed specifications/tasks and breaks implementation down for Opus 5 (senior)
and Sonnet 5 (intermediate). Codex coordinates and independently verifies their
work. This does not authorize simultaneous conflicting edits or duplicate reviews.

The [GitHub project](https://github.com/orgs/Abzum-NZ/projects/2/views/1) remains
the task board. Issues hold scope, acceptance, dependencies and status. Existing
task-plan documents hold material design reasoning. Pull requests hold changes
and review results. Do not build another coordination service or duplicate board.

Keep the issue description current: replace or remove obsolete or irrelevant
scope instead of preserving it under corrective comments. Retain applicable
requirements and dependencies. Use comments for review evidence and progress,
not as a substitute for a clear current description.

## Task handoff

The coordinator supplies the issue, exact base revision, working directory,
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
Track session and model-specific usage. Fable 5.1 consumes its allowance faster,
so reserve it for the complex responsibilities above and scope broad reviews into
coherent passes. If a limit is exhausted, stop retries, wait for the stated reset,
then resume the already assigned work without creating duplicate sessions.

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
  relies on it.
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
  decides, documents material reasoning, developer implements, coordinator reviews.
- Prior safety denials remain binding across tools and agents. Do not recover a
  rejected patch from an older worktree or execute it through Claude as a workaround.
  No permission-bypass mode, credential copying, broad reset or silent deployment.

## Completion handoff

Return: changed functionality; files/commit; tests actually run and results;
remaining acceptance gaps; necessary spec/plan/task updates; and any real blocker.
The coordinator reviews the patch against the issue and approved product model,
returns specific findings to the developer, and merges only after applicable
checks pass. Existing independent approval is reused for unchanged work.

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
