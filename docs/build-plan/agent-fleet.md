# Agent fleet operation

Use the [coordination rules](agent-coordination.md) and the [GitHub pickup queue](https://github.com/orgs/Abzum-NZ/projects/2/views/1). This document governs development work after the 21 September 2026 roadmap review.

## Model routing

| Work | Planned agent |
| --- | --- |
| Mechanical documents, catalogue entries, small explicit adapters | GPT 5.6 Luna (Codex - High) |
| Bounded runtime, UI and service implementation | GPT 5.6 Terra (Codex - High) |
| Cross-engine transactions, authorization and difficult design decisions | GPT 5.6 Sol (Codex - High) |
| Whole-platform architecture and unresolved cross-phase decisions | Coordinator |

Choose the cheapest model able to own the bounded scope. Split large tasks before assigning a larger model. A routine code review can use Terra; use Sol when the changed authority or transaction boundary needs it. Do not add a compulsory planning agent, separate database reviewer, proof worker or hosted tester to each issue.

The issue records the planned lane. At dispatch, record the actual model, task reference and worktree. Check available capacity once and use an available suitable lane; do not loop on unavailable providers or duplicate a worker. Orca-managed workers use the installed Orca CLI. Native Codex reviewers may use native subagents when requested.

## Coordinator loop

Read the complete board and native dependencies. Inspect existing owner/worktree state before dispatch. Give each worker the current issue description, relevant specification, exact base, owned files, subtask estimate and code-review completion criterion. Start independent bounded work when file ownership permits it.

Use the issue estimate as the first progress checkpoint. Inspect actual changes, recent work and the remaining scope. Continue useful progress with a revised estimate, split a demonstrated expansion, or help resolve a concrete blocker. Do not terminate, restart or reassign only because the estimate was exceeded. For long tasks, also inspect progress at 30-minute intervals.

After implementation, get a separate code review, resolve its findings, merge, and settle the board once. Reuse an existing review for unchanged code. No test creation, test execution, database review, hosted receipt, screenshot exercise, release rehearsal or promotion gate is required to finish a development issue.

## Assignment metadata

- Title begins `#<issue>`.
- Phase label is `phase-<number>`.
- Pickup Order is the numeric dependency-respecting sequence.
- Planned agent names the model and effort.
- Estimate is active-agent minutes including normal review corrections; parent totals are rollups.
- Metadata names `#<issue> - <agent name>` and `codex/<issue>-<agent-slug>`.
- Current owner and Dispatch reference are actual execution state, never a planned assignment.

Subtasks have their own issue, agent, estimate and dependencies. Do not dispatch the whole parent and a child to competing developers. Parents aggregate outcomes; epics aggregate phases.

## Development boundaries

All feature branches start from current `origin/main` and target `main`. Code review is the acceptance criterion. Hosting, environment administration and production release are outside this development pass.

Do not preserve obsolete representations for compatibility. Change callers and their owning contracts together. Keep exact publication identities, organisation isolation, access enforcement, atomic operations and safe error handling. These are functionality, not verification gates.

Preserve drafts and worktrees. Handoffs name existing files and commits, including untracked work. Never infer that a stopped terminal means the work was completed or discarded.
