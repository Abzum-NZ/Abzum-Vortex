# Issue 235 local evidence

This directory records credential-free evidence for the Supabase foreign-key index
cleanup in [issue #235](https://github.com/Abzum-NZ/Abzum-Vortex/issues/235).
It contains no database address, credential, token or customer data.

## Scope

Migration `20260905050000_issue235_foreign_key_index_cleanup.sql` changes only
three indexes in `vortex_definition`:

| Foreign key | Covering index | Ordered key columns | Predicate |
| --- | --- | --- | --- |
| `release_dependencies_target_release_fk` | `release_dependencies_target_release_idx` | `target_root_id`, `target_release_revision`, `dependency_version`, `dependency_content_fingerprint` | `target_root_id IS NOT NULL` |
| `roots_current_release_fk` | `roots_current_release_idx` | `root_id`, `current_release_revision` | none |
| `source_identity_aliases_owner_fk` | `source_identity_aliases_owner_idx` | `root_id`, `owner_scope`, `kind`, `component_owner`, `identity_id` | none |

The first index replaces the former two-column target-release index under the
same name. Its two prior leading columns and its `target_root_id IS NOT NULL`
predicate remain intact. The `release_dependencies_target_shape` check requires
a non-null target root precisely for module rows, which are the only rows that
carry a target-release foreign-key tuple. Rows omitted by that predicate have
no target release to check. The two added indexes do not replace the existing
`roots_pkey` or `source_identity_aliases_pk` lookup paths.

## Local catalogue and test proof

After a clean Local reset, a PostgreSQL catalogue query showed that each named
constraint and its intended index have identical ordered key columns. Each
index reported `indisvalid = true` and `indisready = true`; the target-release
predicate deparsed as `(target_root_id IS NOT NULL)` and the other two indexes
had no predicate. A local equivalent of Supabase Splinter's
[`0001_unindexed_foreign_keys` check](https://github.com/supabase/splinter/blob/main/lints/0001_unindexed_foreign_keys.sql)
returned zero rows for all three constraints.

- `pnpm db:test` passed: 13 pgTAP files and 736 assertions.
- `pnpm db:concurrency` passed: all seven two-connection proofs.
- `pnpm db:lint` passed for every Vortex-owned schema with no errors.
- The `pnpm verify` gate's formatting, lint, type, boundary, unit, fixture and
  production-build phases passed with this feature revision.

The new pgTAP assertions resolve each index by its required name, bind it to
the named foreign key's referencing table, compare its complete ordered
key-column array, and require both validity and readiness. They also assert the
allowed target predicate or no predicate as appropriate.
As a mutation check, the Local-only target index was recreated with
`dependency_version` and `target_release_revision` swapped. The focused
`050_definition_release_store.test.sql` suite failed its new assertion,
reporting the reordered actual array; the database was then reset from the
committed migration chain and the full suite passed.

As a separate relation-binding mutation check, a single Local transaction
recreated `source_identity_aliases_owner_idx` on `source_identities`, which has
the same five column names. The pgTAP relation assertion emitted `not ok`,
showing `source_identities` where `source_identity_aliases` was required. The
same session explicitly rolled back and a follow-up catalogue query confirmed
the original valid, ready alias index was restored. This check changed no data
or durable Local schema state.

No table, policy, grant, function, runtime result, API contract or business rule
changed. Hosted Testing delivery, hosted advisers and independent review are
separate protected steps and are not claimed by this local evidence.

Testing execution `7w9iLE15hlvA9ii64ROry` is not the missing complete hosted
proof. It passed the 13 SQL suites and 736 assertions, but the older image-baked
runner selected only three concurrency proofs and omitted `vortex_access` from
lint. [Issue #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266) corrects
that provenance boundary. #235 hosted evidence requires a fresh schema-2 receipt
from the corrected gate; the partial historical run is not reinterpreted.

## Hosted completion evidence — 6 September 2026

[Testing execution `3ZNzrovlUIVUwd11H96KcW`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/3ZNzrovlUIVUwd11H96KcW/outputs)
completed successfully for exact commit
`facc9dc4f81111e2f319de218555a2186235126c`, passing all 30 SQL suites / 1,508 assertions.
Its stored schema-2 receipt reported `succeeded`, 29 listed and applied migrations,
all 14 selected concurrency proofs completed in manifest order, and all five selected
Vortex schemas completed by lint. The migration-set fingerprint was
`ddea42f9d22953499204bb851f9efad6aa3ee8c280eb7ca21387a2c9a735703d`. The complete
receipt fields and independent Git-object comparisons are recorded in the
[issue #266 evidence](../issue-266/README.md#successful-exact-revision-hosted-receipt--6-september-2026).

The #235 feature merge `50b6d4e2a1b7b079d57f8f15d00ee42a29284780` is an ancestor
of that verified commit. The Git blob for
`20260905050000_issue235_foreign_key_index_cleanup.sql` is exactly
`04610168ab1dcaf76e63057e08a9ff3bb7a15bc8` at both revisions, so the corrected
gate exercised the delivered index migration rather than a changed replacement.

At 02:03 UTC on 6 September 2026, fresh hosted Supabase performance and security adviser
results were inspected after that database verification. None of the three foreign
keys owned by #235 appeared in the unindexed-foreign-key findings. A separate
credential-free, read-only PostgreSQL catalogue query returned exactly the three
required constraint/index pairs. Every row bound the intended referencing table,
the exact ordered foreign-key and index column arrays, `indisvalid = true`,
`indisready = true`, and the expected predicate: `(target_root_id IS NOT NULL)` for
`release_dependencies_target_release_idx`, and no predicate for
`roots_current_release_idx` or `source_identity_aliases_owner_idx`.

The remaining four unindexed-foreign-key INFO findings are newer Access storage,
not regressions in this issue's three Definition indexes:

- `permission_registrations_current_revision_fk` belongs to the open
  [permission registry #32](https://github.com/Abzum-NZ/Abzum-Vortex/issues/32).
- `organization_role_permission_entries_role_revision_fk`,
  `organization_role_revisions_role_fk`, and
  `organization_roles_current_revision_fk` belong to the open
  [roles and assignments #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33).

The performance adviser also reported these eleven unused-index INFO findings:

- `vortex_identity.organization_accounts_originating_invitation_idx`
- `vortex_definition.drafts_restored_release_source_idx`
- `vortex_identity.organization_invitations_revoker_idx`
- `vortex_definition.release_dependencies_target_release_idx`
- `vortex_access.organization_group_memberships_account_idx`
- `vortex_access.organization_role_assignments_group_idx`
- `vortex_access.organization_role_activations_account_role_idx`
- `vortex_access.organization_role_activations_role_revision_idx`
- `vortex_access.organization_role_activations_policy_idx`
- `vortex_access.organization_role_activations_membership_idx`
- `vortex_access.organization_delegation_authorities_group_idx`

These are usage-statistics observations on the fresh, low-traffic Testing workload,
not evidence that an index is redundant. None is removed here; representative query
plans and usage must justify any later cleanup. In particular, the named #235
target-release index remains required foreign-key coverage even though current
Testing statistics report no use.

The security adviser reported 26 `rls_enabled_no_policy` INFO findings on intentional
private `vortex_access`, `vortex_definition`, and `vortex_identity` tables. Their
forced-RLS, no-policy, externally denied posture is the private service boundary
established under [#28](https://github.com/Abzum-NZ/Abzum-Vortex/issues/28), not a
request for browser/Data API policies. The only warning was
`auth_leaked_password_protection`, already owned by open
[security readiness #171](https://github.com/Abzum-NZ/Abzum-Vortex/issues/171).
There were no other warnings or errors, and no temporary test-session object was
classified as persistent schema.

An independent Sol source audit re-read the complete issue, migration, catalogue
assertions, mutation evidence, delivery ancestry and current adviser classifications.
It found no implementation blocker: the migration is index-only, preserves the prior
target-release lookup prefix, and changes no table, policy, grant, API contract,
business rule or runtime result. No further #235 migration or broad verification run
is required.
