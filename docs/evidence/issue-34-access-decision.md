# Central access decision — final integration

Owning task: [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34).
Scope and composition: [implementation plan](../build-plan/issue-34-access-decision.md).
Earlier delivered permission checks: [slice 2 evidence](issue-34-permission-eligibility.md).

## Functional result

- The current organisation account needs the exact permission for the declared
  operation. Direct, Group and privileged activation paths use the same database
  decision; personal use does not confer delegation authority.
- Access management additionally requires current delegation covering every
  affected before/after permission. Bounded grants cannot manufacture unrestricted
  catalogue authority. A withdrawn application no longer supplies bounded authority.
- Selecting an application verifies its exact active registration in the selected
  organisation, but grants no permission to use it. Organisation-only requests
  continue to work unchanged.
- The server checks the database result against the trusted operation and resolved
  account, organisation, application and Access version. Only a final allowed
  result invokes the operation within that same transaction. Refusals expose no
  private role or delegation details.

No new permission store, cache, evaluator, policy registry, installation screen,
business-domain rule or AI functionality was introduced. The existing application
coordination concurrency proof now covers both application-selection/withdrawal
orders; the verification manifest still selects 20 proofs, not a duplicate harness.

## Independent review and local verification — 6 September 2026

Sol independently reviewed actual contracts, server integration, SQL and tests
against the task and approved the final source. One application-scope check was
moved before both refusal and success handling, with a focused regression test.
The withdrawal fixtures were corrected to include a valid unaccepted template
state required by the real coordinator; no accepted Role or authority was added.

- Two reviewed migrations applied locally, bringing the recorded total to 42.
  No reset, provider setting or clock change was made.
- All 39 SQL suites / 1,903 assertions passed. Initial full execution encountered
  an intermittent transition failure in the pre-existing suite 180; that suite
  passed all 93 assertions independently, then the unchanged full suite passed.
  This was not represented as a clean first run or fixed by weakening the checks.
- Focused declaration tests passed 10/10. The delegated-management rollback probe
  passed 28/28; application-selection rollback probe passed 12/12.
- Five-schema lint completed without errors. Three existing warnings remain:
  two unused coordinator variables and a text-to-UUID initialization warning.
- Full repository verification passed: 1,216 tests with three existing skips,
  eight fixture checks, all 23 package typechecks/builds, formatting, lint and
  boundary checks.
- All 20 manifest concurrency proofs passed through the standard runner, including
  the extended real application-selection/withdrawal proof. An initial invocation
  stopped before the first pre-existing tenant proof reached its barrier while
  other local checks were running; the unchanged full rerun passed. No timeout,
  invariant or clock setting was weakened to obtain that result.

## Reviewed final source fingerprints

| Artifact | SHA-256 |
|---|---|
| [Delegation evaluator migration](../../supabase/migrations/20260906070152_evaluate_organization_delegated_management_eligibility.sql) | `3ac5094ac3d720329ab56791d6ad5a8f2a64f0e3325a3900303b4d297328dce8` |
| [Application resolver migration](../../supabase/migrations/20260906071702_resolve_human_application_scope.sql) | `429705d04a46a4622d5b8219d28b28aa24bd0ca0755b85c7cd70907d7f6070c1` |
| [Server operation adapter](../../runtime/access/src/organization-access-decision.ts) | `07248a05345c32dd036265d779bb82653b3ec7b1bea1342adecdcdab1481ea12` |
| [Adapter tests](../../runtime/access/test/organization-access-decision.test.ts) | `9d22c1e85546056cd1a9487df5536fbf753d3cc085a42b8645178b02319951bf` |
| [Application coordination concurrency proof](../../supabase/tests/application-access-coordination-concurrency.test.sh) | `a30cee2693f7c7f67c2eef5fa4c1e87374eec433b84b3ac367daeb71291e28d3` |

## Delivery boundary

[PR #309](https://github.com/Abzum-NZ/Abzum-Vortex/pull/309) merged normally after
successful preview checks on 6 September 2026 at 19:55 NZST. The branch ancestry
update was verified to leave the tested `f24b94c` file tree unchanged. The exact
Testing merge is `d554bcb689b31ce238787860ead1bfd91130bc06`.

[Hosted execution `2rlpQddHLvBu3qOnAQrAhW`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/2rlpQddHLvBu3qOnAQrAhW)
completed successfully on 6 September 2026 at 20:25:49.203 NZST, after 30 minutes
32.01 seconds. Root inspected the complete, untruncated schema-2 receipt, not only
the execution badge. Its repository, Testing ref, exact merge and execution match;
all 42 migrations, all 20 selected/completed concurrency proofs in manifest order,
and all five selected/completed schemas are present. The normal SQL gate completed
successfully; the exact source contains 39 SQL suites. CLI `2.116.0`, PostgreSQL 17
and `status: succeeded` are recorded. No Production success is claimed.

The receipt fingerprints were independently recomputed from exact Git revision
`d554bcb689b31ce238787860ead1bfd91130bc06` and match:

| Evidence | SHA-256 |
|---|---|
| Migration set | `cb3a4d457a2d2e3c258945350437d3e81e456a9619e63b0345f32211e304fe6a` |
| Commit-owned runner | `49ca962194c35b4aaa8dc5af6fbaa392604f81df94b70836977f8b1376e68046` |
| Verification manifest | `4d22e86299278cb274e2627669ae492d8e8a991be5c94f8db7d08fa0c9e3b0a3` |
| Selected coverage | `57ac1be58d018af70a7fcbaa70d6c305d1876c50d7e5ac720681282398232879` |

The five verified schemas are `public`, `vortex_context`, `vortex_identity`,
`vortex_definition` and `vortex_access`. Lint reports the same three documented
warnings, not errors. The earlier slice 2 receipt remains separate historical
evidence; this combined receipt completes #34's delivery boundary.

[Organisation administration #30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30)
now consumes this completed boundary without a user hold. Changing operations there and in
[protected Access operations #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40)
own their governance-first resolver and private writer. Neither should upgrade the
ordinary read resolver's shared lock. The existing plan assigns later record,
field, sharing, remote-caller and MCP policies to their actual owning tasks;
unsupported policy is not considered allowed here.
