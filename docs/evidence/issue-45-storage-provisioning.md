# Record storage provisioning — bounded engine proof

[Record storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45) ·
[Module lifecycle #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) ·
[Implementation plan](../build-plan/module-record-provisioning.md)

## Scope

The private database generator prepares storage from an exact published Module
release. The Module coordinator checks the exact Application-to-Module dependency
and current installation authority, then records a **provisioned, inactive**
binding. Request inputs contain release identities and expected binding revision,
not SQL or physical table names.

Storage uses permanent UUID-derived table/column names, compatible shared mappings,
and organisation/application scope. The request role cannot access generated
tables directly. This is preparation for protected record operations, not a
completed application installation or completed Record engine.

## Verification before independent review

| Check | Observed result |
| --- | --- |
| Real database operation | [455 pgTAP proof](../../supabase/tests/455_record_storage_provisioning.test.sql): **24/24 passed**, including initial provisioning, repeat/stale requests, compatible nullable upgrade, incompatible relationship-removal rollback, generated-table scope across two organisations/two applications, and request-role raw-table refusal. The final transaction rolled back. |
| Contracts, Module coordinator and fixtures | Root executed four focused test files: **64/64 passed**. |
| Module types and package boundaries | Root checks passed; all **23 package boundaries** remain valid. |
| Independent implementation review | Initial review requested three corrections; the same independent Sol reviewer subsequently approved the corrected implementation and manifest integration. The reviewer authored neither the storage implementation nor its SQL test. |

Real invocation testing found five query/capability defects and the implementation
author corrected them: unnecessary immutable-release row locks, composite-row
selection, ambiguous conflict-target names, a schema-qualified SQL conditional
expression, and missing permission for the adapter's existing context-reader
dependency. The successful test run includes these corrections.

| File | SHA-256 at successful SQL proof |
| --- | --- |
| [Storage migration](../../supabase/migrations/20260908122641_record_storage_provisioning.sql) | `9b858407802036671e75ee0a28ac644c35570fdb12e5d73c5c66999f06bdf17a` |
| [SQL test](../../supabase/tests/455_record_storage_provisioning.test.sql) | `47921979638896d9ebf0d5f96a7ca1964e4021ca6f3c8c0e819329e9eb475847` |

## Remaining acceptance

Independent review requested corrections after the initial passing proof:

1. Check that the Application root belongs to the intended organisation; a
   globally readable release is not installation authority for another
   organisation's application root.
2. Permit an older pinned release to reuse a newer compatible nullable storage
   shape without treating newer mappings as removals or downgrading the catalogue.
3. Serialize simultaneous first provisioning and support exact response-lost
   retries of the initial null-expected command, without reactivating or retargeting
   an existing binding.

These fixes and their focused regressions are in progress. The hashes and passing
checks above identify the initial reviewed baseline, **not an approved final
implementation**.

The corrected sequential proof subsequently passed **31/31** in a rollback-only
transaction. It includes wrong-organisation Application refusal while allowing a
shared external Module, exact initial null-command replay and retarget refusal,
and newer-storage/older-release reuse without downgrading mappings. Its migration
hash is `533080c5296699fa56c9080f83cef1601da0557e0bd45325a49acb0a95a39ac5` and SQL
test hash is `9a461e17ad852f4fd97156a67943b0f4968c6bd16b77c846c2b3a083a6be9138`.
The [true two-session concurrency proof](../../supabase/tests/module-storage-provisioning-concurrency.test.sh)
then passed twice consecutively. It observed the second backend blocked by the
first using PostgreSQL's actual blocking-session information, then confirmed one
created result, one unchanged retry, binding revision 1 and a single generated
table/mapping. Test-owned fixtures were removed after both runs and exact residue
checks passed. The proof SHA-256 is
`e517e7eae828e705e6833e5dab26ebfe05c07a8a189ea10727b31c7e4364fafc`.
The independent Sol correction review approved this exact migration and both
proof hashes, plus the manifest and specification/build-plan deltas. No additional
blocking findings remained. The test author was not the reviewer.

Root also added the new operated schemas and provisioning concurrency proof to
the existing verification manifest. The scanner now includes `record_data`, which
would previously have been omitted. Its focused unit suite passes **7/7** and
loading the actual repository manifest resolves **26 concurrency proofs and nine
operated schemas**. Database lint is a separate check, not implied by these
manifest tests.

After installing the reviewed authority and corrected storage schema on the
existing local Vortex database, the supported CLI lint reported no schema errors
for `vortex_module`, `vortex_record` and `record_data`. No migration-history entry
was added. The installed CLI did not expose a local security/performance advisor
command, so no advisor result is claimed. The isolated storage suite passes
**50/50**, Contracts and Module type checks pass, and all 23 package boundaries
pass. A later combined fixture run during concurrent calculation implementation
was **63/64**, with a new Definition field-reference failure outside the frozen
storage files; that calculation integration must be resolved before claiming a
green combined branch.

## Testing source delivery

[PR #362](https://github.com/Abzum-NZ/Abzum-Vortex/pull/362) merged normally into
Testing on 8 September 2026 after the exact reviewed source
`917bb98d67d35d69dd32616a56ac662911b2afdd` passed its preview checks. The
[Vercel preview](https://vercel.com/abzumdevteam/abzum-vortex/37K7CTfjAaadNEyE2mpfK8apfpTv)
was visibly **Ready**, with a **6m 50s** build. Testing merge commit:
`a51f10c0c7dd4fed8e08496936cc1be9429a82b8`.

The independent reviewer also confirmed that the new migration and proofs use
committed context, identity, Definition and organisation-authority dependencies;
they do not depend on the unrelated uncommitted record-access migrations or test
helper. This confirms source self-containment, not full hosted execution.

The web build and branch merge do **not** establish that the hosted database has
applied and verified this migration. No Production promotion is claimed.

- Independent actual-work approval is complete. Full ordered migration
  verification and revision-matched hosted verification are not supplied by this
  bounded proof.
- Binding activation/detachment and actual protected Record create, save,
  readback and field projection remain with the owning tasks.
- Relationship mapping and incompatible-removal rollback are tested; protected
  relationship-edge writes are not. The relationship scope trigger remains
  `SECURITY INVOKER`. A proposed switch to `SECURITY DEFINER` was denied and was
  not applied. Its future adapter/catalogue-read boundary must be resolved before
  that write path is delivered, without treating this proof as permission for a
  privilege change.
- No hosted database, Production deployment, migration-history reset or
  infrastructure upgrade is claimed. Whole
  [#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43),
  [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45) and
  [#49](https://github.com/Abzum-NZ/Abzum-Vortex/issues/49) remain incomplete.
