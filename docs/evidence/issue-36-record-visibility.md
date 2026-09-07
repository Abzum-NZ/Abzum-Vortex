# Record visibility implementation evidence

Task: [#36](https://github.com/Abzum-NZ/Abzum-Vortex/issues/36). Scope and acceptance: [implementation plan](../build-plan/issue-36-ownership-and-visibility.md).

## Definition and contract checkpoint — 6 September 2026

This checkpoint defines explicit record visibility alongside existing permissions and carries it through authored source, resolved definitions, provenance, publication validation, release comparison and permission meaning. It does not yet enforce record visibility in the database.

| Delivered foundation             | Evidence                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit record routes           | Canonical unique route sets, all-record exclusivity, declared ownership and relationship source-read permission mapping                                                          |
| Saved condition within a module  | Exact permanent condition identity, published revision, fingerprint, parameter bindings and source provenance; no author-supplied runtime authority                              |
| Application-owned base routes    | Exact bound-module record and relationship references; foreign/unbound permission sources cannot supply scope                                                                    |
| Historical compatibility         | Absent scope stays absent, preserving historical permission-meaning fingerprint bytes; new publication requires explicit record scope                                            |
| Meaning changes                  | Scope differences require a major release comparison and participate in the existing permission-acceptance model                                                                 |
| Local-share contract             | Full stable record scope, account/Group recipient, field bounds, immutable time window, revision and grant/revocation evidence; active shares refuse partial revocation evidence |
| Fixture consistency              | All record permissions in eight existing example modules declare explicit all-record scope; no application-specific runtime branch was added                                     |
| Focused checks                   | Six files, 324 tests pass; contracts, Definition and Access typechecks, scoped formatting/lint and diff checks pass                                                              |
| Independent actual-patch review  | Sol approved the final source and data-contract documentation after the partial-revocation-evidence correction                                                                   |
| Combined repository verification | 1,238 tests pass with three existing skips; eight fixture checks and 23 package typechecks/builds pass, along with formatting, lint and package boundaries                       |

The existing exact readable/changeable field-ID subset comparison is preserved. No new route-count budget, continuity counter, authority evaluator or second expression language was introduced. Direct-share change timestamps describe audit shape; revisions and Access version remain the change-order mechanism.

The checkpoint merged into Testing through [PR #312](https://github.com/Abzum-NZ/Abzum-Vortex/pull/312), after both normal preview checks, at `35b09d1995a56656cbe6f0401666145e4853bd82`. [Combined delivery evidence](issue-40-access-administration.md#testing-merge) distinguishes this verified source merge from the hosted database receipt, which remains unverified. Neither task is marked Done.

## Remaining before the task is complete

1. Complete the remaining inherited-ownership and approved relationship routes. Typed current-person conditions and direct account/current-Group ownership are already implemented as recorded below; they are not new outstanding tasks.
2. Complete current direct-share contribution proof and the private revision-checked share/ownership changes with atomic Access/Activity evidence. Retained facts or individual predicates do not themselves provide complete record authorization.
3. Verify hosted delivery of the combined scope below. Storing and reconstructing scope does not itself enforce record visibility.
4. Complete local, independent review and exact hosted Testing evidence for the full task.

[Row-policy composition #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and [field enforcement #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) retain their real dependencies. There is no record editor, sharing screen, generated-storage or complete MCP claim to screenshot at this checkpoint.

## Shared condition implementation checkpoint — 6 September 2026

The existing Rule package now owns pure typed condition evaluation, with Definition calling that implementation through its existing compatibility entry. Rule is explicitly shared tier 1 and imports only contracts. The input includes trusted source field definitions, exact declared field identifiers and parameter declarations, and exactly their supplied values. Every branch is validated before its Boolean result is used; a hidden invalid branch cannot become an allow result through short-circuiting or negation.

The supported operators retain explicit null, text, number, date, date-time, collection and structural JSON semantics. Field identifiers remain exact and case-sensitive. UUID-valued references compare UUID identity, while text values do not receive case conversion. Contextual collection typing preserves date-like text as text and compares date-time membership by instant. Opaque JSON supports equality, not arbitrary collection operators; an empty literal collection cannot bypass that restriction.

Independent Sol actual-patch review approved the final eight files after one empty-collection correction. The combined focused Rule/Definition check passed all 66 tests; both package typechecks, the 23-package boundary check, formatting and diff checks passed. The combined working-tree repository gate subsequently passed 1,256 tests with three existing skips, eight fixture checks and all 23 package typechecks/builds, plus formatting/lint and boundaries. That run also included the membership reads and parallel catalogue runtime/test changes. This is source-level evidence, not proof of PostgreSQL parity or hosted delivery.

| Final reviewed file                         | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `runtime/rule/src/typed-condition.ts`       | `a5cf2ea81fa56d5b5d21c53f76577ae7532474a3dea3e5028be782f2386cfb5a` |
| `runtime/rule/test/typed-condition.test.ts` | `b9c92b5cd854116e05cae6e6a54da80a4deef225885699c6a16359332cf93c47` |

This source checkpoint merged into Testing through [PR #313](https://github.com/Abzum-NZ/Abzum-Vortex/pull/313), with identical reviewed file bytes at `b1cdd1ea466d583e32f561ea9ae0f46de22b587f`, after both normal preview checks succeeded. [Membership delivery evidence](issue-40-access-administration.md#group-membership-read-checkpoint--6-september-2026) records the separate, still-unverified hosted database result. The task remains In progress.

## Catalogue scope checkpoint — 7 September 2026

The live permission catalogue now preserves optional record scope through registration, withdrawal, candidate matching and permitted reads. Registration still validates the complete candidate against its sealed definition. Historical absence remains SQL NULL and an omitted runtime property; no default scope, backfill or new permission authority is introduced. Existing acceptance, revisions, locks and permission-meaning rules remain authoritative.

Independent Sol review approved all six changed implementation/test files. Focused contract and repository checks passed 25 tests; the actual database proof passed 23 assertions, first in a rolled-back probe and then in the complete local suite. The final combined checkpoint passed repository verification and all 44 database files / 2,087 assertions. Local security advisors reported no issues; database lint retained only the three previously recorded warnings. All 23 concurrency proofs passed across the initial run and a bounded retry, as detailed in [Group change evidence](issue-40-access-administration.md#group-create-and-rename-checkpoint--7-september-2026); this was not one uninterrupted clean concurrency run.

The approved additive migration `20260906113848_preserve_permission_record_scope.sql` has SHA-256 `c1724349422ffe9e9421634a9efd91fcc5118d9bcd90bfa1858373961f313165`. Its proof `340_permission_registry_record_scope.test.sql` has SHA-256 `a024c436e54764c22ada66d231e04bc1212c9704c9783ac761903dc7b257c07e`. Both were applied/tested locally without resetting data. Together with the Group change migration, local history now contains 47 migrations. The source merged normally through [PR #314](https://github.com/Abzum-NZ/Abzum-Vortex/pull/314), with unchanged reviewed bytes at `04819359e55d9176eec7fe3665cd3fb76f32af56`, after both preview checks passed. Hosted database delivery remains unverified, and database visibility evaluation remains outstanding.

## Application-owned saved conditions — 7 September 2026

Application permissions now reuse the module saved-condition source shape. The qualified record type selects exactly one bound module; only its verified compilation output can provide the condition. Validation checks exact module/root/version, resolution and content evidence, organisation and record identity, then reuses the existing condition identity, revision, fingerprint and parameter checks. Duplicate condition identities refuse before map selection. No source form supplies trusted authority.

The original one-argument `compileDefinition` entry remains compatible, including use as an array callback. A separate explicit `compileDefinitionWithContext` entry accepts the closed trusted dependency context. Definition-set compilation supplies previously compiled dependencies in dependency order and refuses external/in-set key conflicts. Publication passes the same verified dependencies into provisional and final compilation using its existing resolution rebasing. Neither step introduces a new registry, fingerprint mechanism or unrelated composition change.

Independent Sol actual-patch review approved all eight source/test files. Focused checks passed 72 tests, including exact owner selection when another module uses the same condition key, missing/stale/tampered evidence, wrong record, duplicate identities, publication consistency and historical byte preservation. Contracts and Definition typechecks, scoped lint/formatting and diff checks passed. Combined repository verification passed 1,265 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. That combined run includes the [invitation correction](issue-315-invitation-audit-time.md), whose complete local database/concurrency evidence is separate. This checkpoint completes the previously missing application-owned condition mapping, not PostgreSQL row enforcement or the full visibility task.

The source checkpoint merged normally through [PR #316](https://github.com/Abzum-NZ/Abzum-Vortex/pull/316), with identical reviewed bytes at `e501d0baff65f491803fb1c99c3fbaeb2ca1f024`, after both preview checks succeeded. [Delivery evidence](issue-315-invitation-audit-time.md#testing-source-delivery) distinguishes this source merge from the unverified hosted database receipt. The whole visibility task remains In progress.

## PostgreSQL condition parity — 7 September 2026

One private, input-only database predicate now evaluates the existing sealed saved-condition restriction. Its three private helpers handle typed values, temporal values and the bounded condition tree. The functions read no authority store, accept no executable SQL and remain unavailable to ordinary runtime/request roles. A rollback-scoped protected test query supplies the verified current account and proves filtering and counting happen in PostgreSQL. This is not yet the complete permission/ownership/share/field decision or a generated record table.

Rule and PostgreSQL consume the exact same 40-vector JSON corpus embedded once in the SQL proof. The existing Rule test reads that tagged literal and rejects a missing or ambiguous corpus; there is no generator or new harness. The vectors cover the twelve operators, compound rules, null/empty behaviour, contextual collections, finite numbers, exact text, UUID-valued references, JSON equality and microsecond date-time comparisons. Four separate SQL cases refuse mismatched condition identity, revision, fingerprint and source record type. Hidden invalid branches and missing node/operator/child shapes refuse instead of becoming allow results through negation or short-circuiting.

Independent Sol review and root execution corrected two SQL null-validation defects, a literal-empty-array typing mismatch, one PostgreSQL conditional-expression syntax error and one unused loop declaration. No extra authority state, counters or approval machinery was introduced. The final reviewed migration has been applied locally without a reset; all 50 local migration entries are recorded. Final scoped SQL execution passes all 77 assertions. Focused Rule and Definition consumer checks pass 76 tests, Rule typechecking passes, and scoped formatting/lint and package-boundary checks are recorded separately from unrelated unfinished role-reader work.

The complete local database suite passed 47 files / 2,202 assertions on the behaviourally identical pre-cleanup version. Its initial run had failed in the unchanged assignment-revocation suite; the isolated original suite and one bounded full retry passed. Independent diagnosis found a real audit-observation defect in that existing writer, now tracked separately as [#318](https://github.com/Abzum-NZ/Abzum-Vortex/issues/318). This condition migration does not repair it, and the passing retry is not described as a clock fix. The final one-line cleanup was independently re-reviewed and all 77 condition assertions rerun successfully.

Database lint reports no errors. Besides the three earlier warnings, it reports five generic volatility warnings for `jsonb_build_object`: those calls here accept only already-typed text, boolean or JSON values, with UUID converted to canonical text. They read no clock, locale-dependent temporal serialization or database state, so the predicate remains input-only. This narrow source assessment preserves the [PostgreSQL immutable-function contract](https://www.postgresql.org/docs/current/xfunc-volatility.html), without adding a helper merely to silence a warning. No new writer/lock path or race framework is introduced; existing governance concurrency evidence is reused, not reported as a fresh run.

The shared corpus also proves that a legacy text current-account parameter does not coerce into a person reference. A separate reviewed follow-up within this task adds the missing explicit reference parameter end-to-end. Hosted delivery remains unverified. There is no new user interface to screenshot.

The checkpoint merged normally through [PR #319](https://github.com/Abzum-NZ/Abzum-Vortex/pull/319) at `2026-09-06T14:00:15Z`, after both preview checks passed. Reviewed source `cbf7b16f5e2206b59ee48e0dcedfd8213fcad043` and Testing merge `413da82f71408a0dc892d761571c05555fa84198` have identical file trees. A subsequent combined repository gate, including frozen but not yet delivered role-reader work, passed 1,279 tests with three existing skips, eight fixture checks, 23 package typechecks/builds and formatting/lint/boundaries. That combined run is not hosted database evidence, and neither the role-reader implementation nor the assignment repair is included in this condition merge.

| Frozen file                                                                   | SHA-256                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260906131348_evaluate_permission_saved_conditions.sql` | `acc80c9d0c031fe7b70dee74daf126dcb4193b7cfc5e4d9fc815bc5a9c60b0e1` |
| `supabase/tests/365_permission_saved_condition_parity.test.sql`               | `f8bffc71ddaeacf4a59ac5acde284233a61145c0e54854ae275356b8e95e14ae` |
| `runtime/rule/test/typed-condition.test.ts`                                   | `f7aa43c2ffefe36cd7a1fe53160fe9ec679eb5b7e2a13bccf65e2c394e99f948` |

## Typed current-person condition parameters — 7 September 2026

A person field can now be compared with the signed-in organisation account using an explicit `organization_account_reference` parameter. Authored and canonical contracts, Definition validation/publication, Rule evaluation and the private database predicate use the same non-nil UUID meaning. Legacy text parameters remain text and still refuse comparison with person references. No field-key normalization, implicit coercion, new evaluator or authority source is added.

Independent Sol review approved all nine frozen implementation/test files. The additive migration preserves the existing function signature and private security settings; a mechanical body comparison limits its functional change to the parameter declaration and current-account binding allowlists. The earlier delivered condition migration is unchanged. The single shared corpus grows from 40 to **43 vectors**, adding the valid current-person comparison and invalid literal/nil-account cases.

The main architect's rollback database probe passes **80 assertions**. After local application, the combined complete database run passes **49 suites / 2,249 assertions**. Focused checks pass 168 tests; the full combined repository gate passes **1,280 tests**, three existing skips, eight fixtures and all 23 package typechecks/builds, formatting/lint and boundaries. The full gate confirms Definition typechecking too; an engineer's earlier standalone run lacked a resolvable local dependency, without requiring any dependency change. Security advisors report no issues; database lint retains the previously reviewed warnings described above.

All 23 existing concurrency proofs passed across multiple runs; [the repair evidence](issue-318-assignment-revocation-audit-time.md#actual-verification) records the unrelated intermittent management-application predicate observation. This pure condition extension adds no concurrency framework. Local history now contains 53 migrations. Ownership, local sharing, relationship routing and final hosted delivery remain unfinished within this task; this checkpoint is not complete record visibility or a new interface.

| Frozen database file                                                         | SHA-256                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906140028_add_organization_account_reference_condition_parameters.sql` | `56bea890abc2e9c9e201880c3168cd8803b8da578510015fa654f4bf7e94d40f` |
| `365_permission_saved_condition_parity.test.sql`                             | `7fba669e1d7c17492cf5be4657606cabcf208bb6d619eaea82b751671e1cf387` |

The typed-reference checkpoint merged normally through [PR #320](https://github.com/Abzum-NZ/Abzum-Vortex/pull/320) at `2026-09-06T14:30:34Z` after both preview checks passed. Reviewed source `ca3d6d6ee89cb143c2986dec1d36d1183d26e748` and Testing merge `e8313abf386338db45dc9cdc9938bba42a78a6a9` have identical file trees. Exact hosted database verification remains unconfirmed; the remaining row-visibility scope is not delivered by that merge.

## Direct account and current-Group ownership — 7 September 2026

One private invoker-rights predicate now evaluates explicit all-record, direct-account and current-Group ownership routes against the trusted installed binding and exact record identity. It checks current Group/membership state and time windows, reports the relevant membership deadline, and refuses foreign organisation/application/storage identities or malformed owner evidence. Unsupported direct-share, relationship and inherited-owner routes add no authority. No record table, ownership mirror, writer, index or runtime endpoint is added.

Independent Sol review approved the frozen migration and test after aligning route order/uniqueness and JSON UUID identities with the existing contracts. The main architect's final rollback proof passes **42 assertions**, including actual restricted-role SQL filtering and counting with a saved condition. A preliminary fixture correctly failed `permission_unavailable`: the existing #34 evaluator excludes record-scoped permissions until #35. The corrected rollback-only fixture authorizes its exact non-record application operation and separately supplies a stored scoped declaration to the private predicate. This tests the trusted integration seam only; it is not complete record authorization. [#35](../build-plan/issue-35-row-policy-composition.md) must bind each eligible record permission to that same permission's current row scope, never mix the two fixture declarations in shipping code.

The reviewed migration was applied locally without reset alongside the assignment ledger, bringing supported local migration history to 55 entries. Full repository verification passes **1,288 tests**, three existing skips, eight fixtures, all 23 package typechecks/builds and formatting/lint/boundaries. Aggregate database results follow below; source delivery remains unverified for this checkpoint. Existing read/governance concurrency evidence is reused because this helper adds no new lock or write path. Local shares, inherited-parent/relationship joins, revision-checked changes and exact hosted delivery remain unfinished within #36. There is no new interface to screenshot.

| Frozen database file                                              | SHA-256                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906144015_evaluate_current_record_ownership_visibility.sql` | `e818c191850c7d18e03093f3d33c13f29c3584c5ad59aaa6a940f96c3be1f000` |
| `385_current_record_ownership_visibility.test.sql`                | `e30a7fb041593e68549c311d675a4d16fcbd6c9f495d63a8949db55640af9445` |

Final aggregate local verification passes **51 database suites / 2,336 assertions**. Six-schema lint reports no errors and only the same eight previously reviewed warnings; neither new migration introduces a warning. Security advisors report no issues. These results do not substitute for exact hosted delivery.

The direct-ownership and assignment-ledger checkpoint merged normally through [PR #321](https://github.com/Abzum-NZ/Abzum-Vortex/pull/321) at `2026-09-06T15:20:45Z`, after both preview checks passed. Reviewed source `20f0ea812c2d00ef94a60f135154b5042983079d` and Testing merge `d60821302149cbe04499116e9c83f4523cb01427` have identical file trees. Exact hosted database receipt remains unverified. This source delivery does not complete the remaining local-share, inherited/relationship and change-composition work.

## Current direct-share contributions — 7 September 2026

One private table retains exact local record shares to an organisation account or Group, including independent field bounds, grant windows and terminal revision-checked revocation. One owner-only reader returns each current contribution separately. It checks the complete trusted record/storage binding, current Group membership and the earliest applicable share/membership deadline. It neither unions fields nor supplies operation permission. An already verified account/context comes from the existing Access boundary; no duplicate account-authority evaluator was added.

The migration passed a rollback-only probe with **43 assertions** and was applied only to the existing local Vortex database, without reset. Independent actual-work review required an additional restricted-role invocation, rather than treating ACL inspection as that proof. The final **44-assertion** suite includes a rollback-only protected wrapper that accepts only a record identity, obtains the organisation/application/account from validated context, and uses a controlled installed binding. It excludes another account's share and a removed Group-membership route. The first execution exposed a missing fixture Access-version initialization; the existing initializer corrected the fixture, without changing production behavior. The corrected test was independently re-reviewed and passes.

This remains a pre-policy integration seam, not a shipping record endpoint. [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) must still pair each eligible record permission with its own complete visibility scope. [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) owns final field ceilings and actual share invocation; [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45) supplies generated storage bindings. Inherited ownership, relationship routing and private share/ownership writers remain unfinished in this task. No UI, MCP tool or actual record-sharing screen is claimed.

Local history contains **57 migrations**, including the separately reviewed activation-ledger addition. The initial combined suite passes 53 files / 2,417 assertions before the extra restricted-role assertion; the final aggregate result is recorded below when complete. All **23 existing concurrency proofs pass in one uninterrupted run**. Six-schema lint has no errors and only the same eight previously reviewed warnings. Full repository verification passes **1,292 tests**, three existing skips, eight fixtures and all 23 package typechecks/builds plus formatting/lint/boundaries. No fresh security-advisor or hosted result is claimed by these checks.

| Frozen database file                                          | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906152638_retain_direct_record_share_contributions.sql` | `7fc01d52f17e8dd0cf123a974e03b239df1a9f8d2a644ad7fde24dc472d8ccf0` |
| `390_current_direct_record_share_contributions.test.sql`      | `f83bbc3b93b70f2076cd898b85612ea36437a199cf9579a0e538d033d38083cd` |

Final independent Sol review approves these exact bytes with no findings. The final full local suite passes **53 files / 2,418 assertions**. Before that passing aggregate retry, the unchanged permission-eligibility suite stopped after 43 assertions in the permanent-steward safeguard; its isolated 48-assertion run passed. [The existing #318 observation](https://github.com/Abzum-NZ/Abzum-Vortex/issues/318#issuecomment-5563910662) retains that failure and its unproven cause. The retry is not a fix, and no clock adjustment, reset or safeguard relaxation was introduced. Both new suites pass; exact hosted verification remains required separately.
