# Agent coordination

The [GitHub project](https://github.com/orgs/Abzum-NZ/projects/2) records current work. Issue descriptions hold scope, specification links, bounded subtasks, dependencies, code-review acceptance, planned agents, estimates and branch names. The [roadmap](README.md) defines the phases. The 21 September 2026 development policy replaces earlier testing, hosted-proof, compatibility and promotion requirements.

## Delivery

1. Pick the lowest Pickup Order whose unfinished dependencies are complete. Process one implementation issue at a time, including its review-and-fix stage, before taking the next issue.
2. Read the issue, relevant specification and current source. Read the archived salvage map and selectively reuse applicable product changes in a fresh worktree; never resume a retired agent session.
3. Implement the bounded functionality in an issue worktree from current `origin/main`.
4. A separate Opus 5 or GPT 5.6 Sol review agent takes exclusive edit ownership, reads the code against acceptance, fixes findings itself and re-reviews the final changes.
5. The review-and-fix agent integrates the reviewed implementation through the repository workflow and closes its assigned issue; the coordinator updates the shared board once. Parent issues close when their implementation subtasks are complete.

Code review is the only task acceptance requirement. Do not add or run tests, database reviews, hosted verification, screenshots, proof receipts, performance exercises or release gates. An existing test or historical failed run does not create work under a functionality issue. Do not delete unrelated existing files to simplify a task.

Correct the source of a defect. This is a new application with no backward-compatibility requirement: contracts and storage shapes can change together. Do not build V1/V2 parallel implementations or old-reader conversions. Product requirements for explicit publication, exact installed versions, permission checks and transaction integrity remain in scope.

## Roles and assignments

The coordinator owns issue and board changes, dependency order and worker handoffs. Review workers use the coordinator's complete issue snapshot. A developer owns one bounded implementation. The review-and-fix owner fixes its own findings and re-reviews before closing the task. A database or hosted reviewer is not required.

Planned assignments are provisional. Follow [model routing and quota reserves](agent-fleet.md): GLM for explicit mechanical work, Gemini Flash High for bounded UI work, Sonnet for normal implementation, and Opus/Sol for complex work. Every final reviewer must be Opus 5 or GPT 5.6 Sol in a separate session from the implementer. Before pickup or reassignment, read provider usage and update the issue's planned agent, estimate, metadata and parent row together. Current owner and Dispatch identify the actual worker, not a plan.

Each child issue has its own estimate and worktree/branch metadata. A parent estimate is the sum of its children, not additional effort. Estimates are active-agent minutes for implementation and code-review corrections; queued and blocked time is excluded. They are planning estimates, not promises.

At the estimate, inspect the diff and recent progress. Record what is complete, the blocker or remaining work, and a revised estimate or a smaller follow-up. Keep a progressing worker running. Escalate only the specific unresolved problem; elapsed time alone is never a kill condition.

## Status

- Backlog: planned work with unfinished dependencies, or work not yet picked up.
- Ready: unblocked implementation that can be picked up.
- In progress: an active developer is implementing the issue.
- In review: an active reviewer or coordinator owns review corrections or merge.
- Done: implemented, code-reviewed and merged; cancelled issues are closed as not planned, not delivered functionality.

Update status at every ownership transition and inspect actual progress at the estimate or 30 minutes. Resolve concrete stalls, preserve work on provider failure, and confirm the old editor is stopped before replacement. Testing is not part of this development workflow. Do not mark code complete because a worker merely stopped, and do not hold completed functionality for database or hosted evidence.

## Worktree and communication

Use `#<issue> - <agent name>` as the worktree display name and `codex/<issue>-<agent-slug>` as the branch name. Use fresh sessions after this reset. Record the actual branch returned by Orca. Retire each finished worktree after preserving committed work and useful notes. One developer edits a worktree at a time. Preserve untracked work during handoff.

Keep progress concise: functionality changed, files or commit, remaining implementation work and next owner. Do not append repetitive progress comments to issue pages. The current description and board fields must remain sufficient to implement the task.

This development plan does not deploy, reset or administer a hosted environment. Keep credentials out of source, prompts, logs and browser bundles.
