# Agent coordination

The [GitHub project](https://github.com/orgs/Abzum-NZ/projects/2) records current work. Issue descriptions hold scope, specification links, bounded subtasks, dependencies, code-review acceptance, planned agents, estimates and branch names. The [roadmap](README.md) defines the phases. The 21 September 2026 development policy replaces earlier testing, hosted-proof, compatibility and promotion requirements.

## Delivery

1. Pick the lowest Pickup Order whose unfinished dependencies are complete. Independent items may run together when they do not share an editing boundary.
2. Read the issue, relevant specification and current source. Resume preserved work before creating a duplicate worker.
3. Implement the bounded functionality in an issue worktree from current `origin/main`.
4. A separate reviewer reads the code against the issue's acceptance criteria. Address concrete implementation findings.
5. Merge the reviewed implementation through the normal repository workflow and close the completed issue. Parent issues close when their implementation subtasks are complete.

Code review is the only task acceptance requirement. Do not add or run tests, database reviews, hosted verification, screenshots, proof receipts, performance exercises or release gates. An existing test or historical failed run does not create work under a functionality issue. Do not delete unrelated existing files to simplify a task.

Correct the source of a defect. This is a new application with no backward-compatibility requirement: contracts and storage shapes can change together. Do not build V1/V2 parallel implementations or old-reader conversions. Product requirements for explicit publication, exact installed versions, permission checks and transaction integrity remain in scope.

## Roles and assignments

The coordinator owns issue and board changes, dependency order and worker handoffs. Review workers use the coordinator's complete issue snapshot. A developer owns one bounded implementation. A separate code reviewer checks the result; a second database or hosted reviewer is not required.

Planned agent is a cost-based assignment, not evidence of a running session. Current owner and Dispatch reference identify the actual active worker. Keep those fields separate. Prefer GPT 5.6 Luna (Codex - High) for mechanical changes, GPT 5.6 Terra (Codex - High) for bounded implementation, and GPT 5.6 Sol (Codex - High) for complex cross-engine or authorization work. Use other configured workhorse providers when they fit the same scope and are available.

Each child issue has its own estimate and worktree/branch metadata. A parent estimate is the sum of its children, not additional effort. Estimates are active-agent minutes for implementation and code-review corrections; queued and blocked time is excluded. They are planning estimates, not promises.

At the estimate, inspect the diff and recent progress. Record what is complete, the blocker or remaining work, and a revised estimate or a smaller follow-up. Keep a progressing worker running. Escalate only the specific unresolved problem; elapsed time alone is never a kill condition.

## Status

- Backlog: planned work with unfinished dependencies, or work not yet picked up.
- Ready: unblocked implementation that can be picked up.
- In progress: an active developer is implementing the issue.
- In review: an active reviewer or coordinator owns review corrections or merge.
- Done: implemented, code-reviewed and merged; cancelled issues are closed as not planned, not delivered functionality.

Testing is not part of this development workflow. Do not mark code complete because a worker merely stopped, and do not hold completed functionality for database or hosted evidence.

## Worktree and communication

Use `#<issue> - <agent name>` as the worktree display name and `codex/<issue>-<agent-slug>` as the branch name. Preserve an existing worktree and record its actual branch if work is already underway. One developer edits a worktree at a time. Preserve untracked work during handoff.

Keep progress concise: functionality changed, files or commit, remaining implementation work and next owner. Do not append repetitive progress comments to issue pages. The current description and board fields must remain sufficient to implement the task.

This development plan does not deploy, reset or administer a hosted environment. Keep credentials out of source, prompts, logs and browser bundles.
