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

1. PostgreSQL evaluation and parity for the shared pure typed condition implementation described below. The pure implementation is available to Definition and Access; actual database restrictions are not delivered by that extraction alone.
2. Minimal trusted dependency-condition evidence for application-owned saved conditions, derived from the exact bound module compilation artifact and revalidated against it. The current identity/version snapshot does not contain that immutable condition contract; the compiler currently refuses unsupported application saved conditions rather than inventing it.
3. Additive live catalogue storage, validation and read reconstruction of scope. Contract and compiler support alone cannot register or enforce it through the current scope-less catalogue.
4. Private current shares, ownership/Group/relationship/condition database restrictions, and revision-checked changes with atomic Access/Activity evidence.
5. Complete local, independent review and exact hosted Testing evidence for the full task.

[Row-policy composition #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and [field enforcement #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) retain their real dependencies. There is no record editor, sharing screen, generated-storage or complete MCP claim to screenshot at this checkpoint.

## Shared condition implementation checkpoint — 6 September 2026

The existing Rule package now owns pure typed condition evaluation, with Definition calling that implementation through its existing compatibility entry. Rule is explicitly shared tier 1 and imports only contracts. The input includes trusted source field definitions, exact declared field identifiers and parameter declarations, and exactly their supplied values. Every branch is validated before its Boolean result is used; a hidden invalid branch cannot become an allow result through short-circuiting or negation.

The supported operators retain explicit null, text, number, date, date-time, collection and structural JSON semantics. Field identifiers remain exact and case-sensitive. UUID-valued references compare UUID identity, while text values do not receive case conversion. Contextual collection typing preserves date-like text as text and compares date-time membership by instant. Opaque JSON supports equality, not arbitrary collection operators; an empty literal collection cannot bypass that restriction.

Independent Sol actual-patch review approved the final eight files after one empty-collection correction. The combined focused Rule/Definition check passed all 66 tests; both package typechecks, the 23-package boundary check, formatting and diff checks passed. The combined working-tree repository gate subsequently passed 1,256 tests with three existing skips, eight fixture checks and all 23 package typechecks/builds, plus formatting/lint and boundaries. That run also included the membership reads and parallel catalogue runtime/test changes. This is source-level evidence, not proof of PostgreSQL parity or hosted delivery.

| Final reviewed file | SHA-256 |
|---|---|
| `runtime/rule/src/typed-condition.ts` | `a5cf2ea81fa56d5b5d21c53f76577ae7532474a3dea3e5028be782f2386cfb5a` |
| `runtime/rule/test/typed-condition.test.ts` | `b9c92b5cd854116e05cae6e6a54da80a4deef225885699c6a16359332cf93c47` |
