## Functionality

Issue #
Describe the implemented behavior and bounded scope.

## Code review

Reviewer: Opus 5 / GPT 5.6 Sol, separate session from implementer.
Final reviewed commit:
Acceptance criteria addressed:
Findings fixed and re-reviewed:
Remaining limitations or explicitly deferred scope:

## Product correctness reviewed in source

- [ ] Organisation isolation, current permission checks, atomic writes, revision checks and safe errors are preserved.
- [ ] Every schema change ships as an ordered migration file; an already-applied file is corrected by a later migration.
- [ ] No package reaches inside another package's files; nothing depends upward.
- [ ] Specification, data contracts and build plan were reviewed and either updated here or recorded as unchanged.
- [ ] No secret or credential appears in source, logs, prompts or browser bundles.

## Completion handoff

After reviewed integration, the reviewer updates/closes the assigned issue and sends the merge commit and summary to the orchestrator. The orchestrator updates the board, unblocks dependents, releases the agent, preserves/removes the completed worktree and selects the next strict pickup.

Development acceptance is implementation plus code review, as recorded in [agent coordination](../docs/build-plan/agent-coordination.md), `docs/specification/18-delivery-and-testing.md` and `docs/specification/20-quality-and-acceptance.md`. No tests, build/lint/typecheck gates, database or hosted evidence, screenshots, Kestra receipts or deployment are required. Do not add those steps to this pull request, and merging this change claims no Production release.
