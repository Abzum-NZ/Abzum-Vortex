# Record visibility implementation evidence

Task: [#36](https://github.com/Abzum-NZ/Abzum-Vortex/issues/36). Scope and acceptance: [implementation plan](../build-plan/issue-36-ownership-and-visibility.md).

## Definition and contract checkpoint — 6 September 2026

This checkpoint defines explicit record visibility alongside existing permissions and carries it through authored source, resolved definitions, provenance, publication validation, release comparison and permission meaning. It does not yet enforce record visibility in the database.

| Delivered foundation | Evidence |
|---|---|
| Explicit record routes | Canonical unique route sets, all-record exclusivity, declared ownership and relationship source-read permission mapping |
| Saved condition within a module | Exact permanent condition identity, published revision, fingerprint, parameter bindings and source provenance; no author-supplied runtime authority |
| Application-owned base routes | Exact bound-module record and relationship references; foreign/unbound permission sources cannot supply scope |
| Historical compatibility | Absent scope stays absent, preserving historical permission-meaning fingerprint bytes; new publication requires explicit record scope |
| Meaning changes | Scope differences require a major release comparison and participate in the existing permission-acceptance model |
| Local-share contract | Full stable record scope, account/Group recipient, field bounds, immutable time window, revision and grant/revocation evidence; active shares refuse partial revocation evidence |
| Fixture consistency | All record permissions in eight existing example modules declare explicit all-record scope; no application-specific runtime branch was added |
| Focused checks | Six files, 324 tests pass; contracts, Definition and Access typechecks, scoped formatting/lint and diff checks pass |
| Independent actual-patch review | Sol approved the final source and data-contract documentation after the partial-revocation-evidence correction |
| Combined repository verification | 1,238 tests pass with three existing skips; eight fixture checks and 23 package typechecks/builds pass, along with formatting, lint and package boundaries |

The existing exact readable/changeable field-ID subset comparison is preserved. No new route-count budget, continuity counter, authority evaluator or second expression language was introduced. Direct-share change timestamps describe audit shape; revisions and Access version remain the change-order mechanism.

The checkpoint merged into Testing through [PR #312](https://github.com/Abzum-NZ/Abzum-Vortex/pull/312), after both normal preview checks, at `35b09d1995a56656cbe6f0401666145e4853bd82`. [Combined delivery evidence](issue-40-access-administration.md#testing-merge) distinguishes this verified source merge from the hosted database receipt, which remains unverified. Neither task is marked Done.

## Remaining before the task is complete

1. The typed current-account/person parameter correction described in the [current plan](../build-plan/issue-36-ownership-and-visibility.md#next-condition-correction-compare-a-person-field-with-the-current-account). The PostgreSQL condition-parity checkpoint below is locally verified; it does not by itself complete all visibility routes or generated-table enforcement.
2. Hosted delivery of the locally verified catalogue and application-condition checkpoints below. Storing and reconstructing scope does not itself enforce record visibility.
3. Private current shares, ownership/Group/relationship/condition database restrictions, and revision-checked changes with atomic Access/Activity evidence.
4. Complete local, independent review and exact hosted Testing evidence for the full task.

[Row-policy composition #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and [field enforcement #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) retain their real dependencies. There is no record editor, sharing screen, generated-storage or complete MCP claim to screenshot at this checkpoint.

## Shared condition implementation checkpoint — 6 September 2026

The existing Rule package now owns pure typed condition evaluation, with Definition calling that implementation through its existing compatibility entry. Rule is explicitly shared tier 1 and imports only contracts. The input includes trusted source field definitions, exact declared field identifiers and parameter declarations, and exactly their supplied values. Every branch is validated before its Boolean result is used; a hidden invalid branch cannot become an allow result through short-circuiting or negation.

The supported operators retain explicit null, text, number, date, date-time, collection and structural JSON semantics. Field identifiers remain exact and case-sensitive. UUID-valued references compare UUID identity, while text values do not receive case conversion. Contextual collection typing preserves date-like text as text and compares date-time membership by instant. Opaque JSON supports equality, not arbitrary collection operators; an empty literal collection cannot bypass that restriction.

Independent Sol actual-patch review approved the final eight files after one empty-collection correction. The combined focused Rule/Definition check passed all 66 tests; both package typechecks, the 23-package boundary check, formatting and diff checks passed. The combined working-tree repository gate subsequently passed 1,256 tests with three existing skips, eight fixture checks and all 23 package typechecks/builds, plus formatting/lint and boundaries. That run also included the membership reads and parallel catalogue runtime/test changes. This is source-level evidence, not proof of PostgreSQL parity or hosted delivery.

| Final reviewed file | SHA-256 |
|---|---|
| `runtime/rule/src/typed-condition.ts` | `a5cf2ea81fa56d5b5d21c53f76577ae7532474a3dea3e5028be782f2386cfb5a` |
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

| Frozen file | SHA-256 |
|---|---|
| `supabase/migrations/20260906131348_evaluate_permission_saved_conditions.sql` | `acc80c9d0c031fe7b70dee74daf126dcb4193b7cfc5e4d9fc815bc5a9c60b0e1` |
| `supabase/tests/365_permission_saved_condition_parity.test.sql` | `f8bffc71ddaeacf4a59ac5acde284233a61145c0e54854ae275356b8e95e14ae` |
| `runtime/rule/test/typed-condition.test.ts` | `f7aa43c2ffefe36cd7a1fe53160fe9ec679eb5b7e2a13bccf65e2c394e99f948` |

## Typed current-person condition parameters — 7 September 2026

A person field can now be compared with the signed-in organisation account using an explicit `organization_account_reference` parameter. Authored and canonical contracts, Definition validation/publication, Rule evaluation and the private database predicate use the same non-nil UUID meaning. Legacy text parameters remain text and still refuse comparison with person references. No field-key normalization, implicit coercion, new evaluator or authority source is added.

Independent Sol review approved all nine frozen implementation/test files. The additive migration preserves the existing function signature and private security settings; a mechanical body comparison limits its functional change to the parameter declaration and current-account binding allowlists. The earlier delivered condition migration is unchanged. The single shared corpus grows from 40 to **43 vectors**, adding the valid current-person comparison and invalid literal/nil-account cases.

The main architect's rollback database probe passes **80 assertions**. After local application, the combined complete database run passes **49 suites / 2,249 assertions**. Focused checks pass 168 tests; the full combined repository gate passes **1,280 tests**, three existing skips, eight fixtures and all 23 package typechecks/builds, formatting/lint and boundaries. The full gate confirms Definition typechecking too; an engineer's earlier standalone run lacked a resolvable local dependency, without requiring any dependency change. Security advisors report no issues; database lint retains the previously reviewed warnings described above.

All 23 existing concurrency proofs passed across multiple runs; [the repair evidence](issue-318-assignment-revocation-audit-time.md#actual-verification) records the unrelated intermittent management-application predicate observation. This pure condition extension adds no concurrency framework. Local history now contains 53 migrations. Ownership, local sharing, relationship routing and final hosted delivery remain unfinished within this task; this checkpoint is not complete record visibility or a new interface.

| Frozen database file | SHA-256 |
|---|---|
| `20260906140028_add_organization_account_reference_condition_parameters.sql` | `56bea890abc2e9c9e201880c3168cd8803b8da578510015fa654f4bf7e94d40f` |
| `365_permission_saved_condition_parity.test.sql` | `7fba669e1d7c17492cf5be4657606cabcf208bb6d619eaea82b751671e1cf387` |
