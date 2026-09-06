# Assignment revocation audit-time repair

Task: [#318](https://github.com/Abzum-NZ/Abzum-Vortex/issues/318). This is a bounded correction to the delivered [Roles and Groups #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) writer, not a new authorisation mechanism or infrastructure investigation.

## Demonstrated failure and correction — 7 September 2026

The existing private assignment coordinator locked and revision-checked a live assignment, but wrote an unqualified current clock value during revocation. If the predecessor's stored audit timestamp was later than that observation, the existing transition protector rejected the otherwise valid revocation. The original assignment SQL suite exposed this intermittently during record-condition verification.

The additive [migration](../../supabase/migrations/20260906135228_preserve_role_assignment_revocation_audit_time.sql) changes only that revocation timestamp selection to the greater of the locked predecessor's `changed_at` and the current clock observation. Expected revisions, tenant scoping, the transaction, immutable grant facts, terminal revocation, the existing single Access increment, and the outer stewardship composition are unchanged. No clock adjustment, new counter, approval, retry framework or expiry change is introduced.

## Actual verification

- The [regression fixture](../../supabase/tests/375_role_assignment_revocation_audit_time.test.sql) uses a valid privileged role with an actual registered administrative permission. Accepted entries are inserted before revision sealing, and deferred integrity constraints are flushed. It does not disable constraints or invent a platform capability.
- With the existing writer, the frozen fixture fails at the revocation transition with `Organization role assignment transition is invalid`.
- With the reviewed migration in the same rolled-back local transaction, all **13 assertions pass**. These cover preserved private execution boundaries, successful revision-checked revocation, coherent result/stored audit evidence, unchanged grant facts, one Access increment with the existing reason, and stale retry refusal without another increment.
- The future predecessor timestamp is test data; the local or hosted clock was not changed.
- Independent Sol review approved the actual migration and final corrected fixture. The main architect executed both the failing baseline and passing repair.
- Applied to the local test database and recorded in local migration history only. The combined final database run passes **49 suites / 2,249 assertions**, including the existing assignment suite and this regression. The combined repository gate passes **1,280 tests** with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries.
- All 23 existing concurrency proofs passed across the main run and a subsequent bounded run of the last six. This was not one uninterrupted success: the existing management-application proof twice found the final permanent-steward predicate false despite the expected committed/rejected competing operations. Its final unchanged proof then passed, as did the remaining five checks. A failure-only in-memory diagnostic was prepared but did not fire on that passing run, so no particular timing or structural leaf is claimed as proven. The reviewed revocation correction does not execute on that path. Preserve this observation in delivery evidence; do not change clocks, weaken expectations or claim an infrastructure repair.
- Six-schema lint reports no errors, retaining three older Access warnings and the five already-reviewed generic immutable/JSON construction warnings documented in [condition parity evidence](issue-36-record-visibility.md#postgresql-condition-parity--7-september-2026). Security advisors report no warnings or errors.
- Exact hosted delivery remains unverified. Normal source/preview delivery must not be described as a hosted database receipt.

## Testing source delivery

[PR #320](https://github.com/Abzum-NZ/Abzum-Vortex/pull/320) merged normally at `2026-09-06T14:30:34Z` after Vercel and Vercel Preview Comments passed. Reviewed source `ca3d6d6ee89cb143c2986dec1d36d1183d26e748` and Testing merge `e8313abf386338db45dc9cdc9938bba42a78a6a9` have identical file trees. No check was bypassed. Exact hosted database verification remains unconfirmed, so this repair remains in review rather than being closed on preview evidence alone.

## Frozen proof artifacts

| Artifact | SHA-256 |
|---|---|
| Migration | `c39656e4cb30cc29991be3829770a466e0ab439f499dc5bfb4be1b7cd34b156c` |
| SQL375 fixture | `48c64c685b4fc92afadbe960cf59730e25a9f28e45e8e3aa2c97114c7cffb53e` |

This is a database behaviour correction with no new visible interface to screenshot. Successful local checks are not described as hosted verification or a completed IAM administration interface.
