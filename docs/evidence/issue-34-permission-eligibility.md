# Current permission eligibility — issue 34, slice 2

Owning task: [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34).
Scope: [central access decision plan](../build-plan/issue-34-access-decision.md).

One private database function evaluates the transaction-bound account's current
permission through a complete direct-standing, Group-standing, direct-activation
or Group-activation path. It checks exact organisation/application scope, current
permission meaning, retained role acceptance, live assignment and activation
bindings, and any required genuine recent authentication. Its deadline belongs to
the selected complete path, not a mixture of grants.

This is permission eligibility, not final allowance. Management without the
remaining delegation evaluator and unsupported target/caller policies refuse.
There is no new table, permission cache, second role evaluator, public endpoint,
IAM interface or application-specific logic.

## Local verification — 6 September 2026

- Independent Sol task-versus-work review approved the implementation, focused
  tests, concurrency proof and manifest entry. The final test-only correction uses
  SQL-special-form `coalesce` and received a separate reviewer confirmation.
- One additive migration applied locally; 40 migrations are present. No reset or
  signing-key change was needed.
- Focused restricted-request-role suite: all 48 assertions passed.
- Full database suite: all 37 SQL files / 1,863 assertions passed.
- All 20 manifest concurrency proofs passed through the standard local runner.
  The new proof also passed individually. It exercises an actual assignment revoke
  against a completed permission read and an actual grant holding up a reader until
  the reader's prior permission expires. Exact blocking sessions and final states
  are checked; only fixture-owned data is cleaned up.
- Five-schema lint passed without errors; the same three pre-existing warnings
  remain (two unused coordinator variables and one text-to-UUID initialization).
- Full repository verification passed: formatting, lint, package boundaries,
  typechecks, tests, fixture validation and builds.

## Reviewed source

| Artifact | SHA-256 |
|---|---|
| [Migration](../../supabase/migrations/20260906055827_evaluate_organization_permission_eligibility.sql) | `fb53f9c5d3521f7ca4029c1030d6c9cb95e67bfdb07ba510c4ca0a52b26144ff` |
| [Focused tests at the delivered revision](https://github.com/Abzum-NZ/Abzum-Vortex/blob/69eaf51ebf5b65e90542e097bac1cff622c624d4/supabase/tests/290_organization_permission_eligibility.test.sql) | `136400ed929ec33db9d9128b60420f7ba16936d27cf3a1847eb4f116dd88a8b0` |
| [Concurrency proof](../../supabase/tests/organization-permission-eligibility-concurrency.test.sh) | `1d2a8c782639550acdf0b9b5042bf1c42cba8cb50c7866f5ff3341d37957f954` |
| [Coverage manifest](../../workflows/kestra/database-verification.json) | `4d22e86299278cb274e2627669ae492d8e8a991be5c94f8db7d08fa0c9e3b0a3` |

## Delivery and remaining work

[PR #308](https://github.com/Abzum-NZ/Abzum-Vortex/pull/308) merged after successful
normal preview checks as Testing `69eaf51ebf5b65e90542e097bac1cff622c624d4`.
[Execution `2Hb4Y52VOQvB9UFCbYP5vH`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/2Hb4Y52VOQvB9UFCbYP5vH)
succeeded on 6 September 2026 at 19:31:35 NZST after 29 minutes 3.64 seconds.
The complete schema-version 2 stored receipt was inspected, not only the status:
40 migrations, all 20 selected concurrency proofs completed, and all five selected
lint schemas completed. The delivered tree contains 37 SQL suites; the normal SQL
test gate succeeded before the receipt was published. The same three existing lint
warnings remain; there were no lint errors.

The receipt's source hashes were independently recomputed from the exact merged
Git commit and matched:

| Evidence | SHA-256 |
|---|---|
| Migration set | `97b24c1f0aeb2864b7b53ca3f5b54ad449b73e39aed573f2b8fb53e2d22073e0` |
| Delivery runner | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Verification manifest | `4d22e86299278cb274e2627669ae492d8e8a991be5c94f8db7d08fa0c9e3b0a3` |
| Selected verification coverage | `57ac1be58d018af70a7fcbaa70d6c305d1876c50d7e5ac720681282398232879` |

This completes hosted evidence for slice 2, not #34 or Production promotion.
The next slice adds current delegation coverage to the same evaluator. Final server/target-policy composition
then makes it consumable by protected operations. [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30)
and [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) retain their actual
dependencies; no new user hold is introduced.
