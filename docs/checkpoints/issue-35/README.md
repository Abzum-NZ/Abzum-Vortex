# Unfinished row-policy checkpoint

[Task #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) remains open.
These text artifacts preserve existing unmerged work during the 10 September
2026 branch consolidation. They are **not executable migrations or test gates**.

- [Permission eligibility source](permission-eligibility.sql.txt): extracted
  shared role-path logic and record-candidate eligibility, not a complete row
  access decision. Its original migration name was
  `20260909185711_extract_shared_record_permission_eligibility.sql`.
- [Record-facts fixture](record-facts-fixture.sql.txt): factual loaders and their
  tests, not composed eligibility, RLS or hosted evidence. Its original name was
  `430_exact_record_access.test.sql`.
- The second migration, `20260909185719_compose_exact_record_access.sql`, was
  empty and is deliberately omitted from the executable migration sequence.

Independent review confirmed that shipping the helper alone would contradict
the [row-policy delivery plan](../../build-plan/issue-35-row-policy-composition.md).
The user limited consolidation to existing unmerged work, not completion of all
acceptance criteria of every active issue. Preserve this checkpoint for the next
implementation; do not claim #35 complete or deploy it without the actual complete
decision, neutral-policy proofs, legacy regression and hosted verification.

The earlier explicitly rejected candidates in the old stewardship worktree remain
excluded. These are the later fresh checkpoint only. Review against current source
before any reuse, and generate correctly ordered migrations through the normal
gate when the complete bounded implementation is ready.
