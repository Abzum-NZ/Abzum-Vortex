# Authority ledgers and role continuity — design record (25 September 2026)

**Status:** Decision-ready proposal for the product owner. Document only: no code, no SQL, no migration is added by this issue. The [architecture freeze and owner decisions of 24–25 September](architecture-decisions-2026-09-25.md) apply.

**Issue:** [#1072](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1072) — design record on replacing role continuity numbers and five separate authority ledgers with ordinary roles and one assignment ledger.

**Review baseline:** [Architecture decisions 25 September 2026](architecture-decisions-2026-09-25.md) and its appendices; [04 Access and permissions](../specification/04-access-and-permissions.md); [Groups and privileged role activation](../specification/appendices/groups-and-privileged-access.md); live SQL on `origin/main`.

**Binding owner decisions (2026-09-24):**
1. The **security operator** and **support operator** are **ordinary roles**, assignable to any user in the organisation through the ordinary catalogue. They are not a special actor class.
2. **All approvals are backend workflows configured in Kestra.** Core keeps **no bespoke approval functionality and no approver checks**. The only fixed (non-configurable) access rule remains the one in Decision 11: a grant operation refuses any role or role template containing a permission outside the actor's own delegated scope.

---

## 1. The problem in one page

Today one organisation role carries **nine source fingerprints** and authority is held through **five separate ledgers**:

| # | Ledger | Principal table(s) |
| --- | --- | --- |
| L1 | Assignments with activations | `organization_role_assignments`, `organization_role_activations`, `organization_role_activation_policy_revisions` |
| L2 | Delegation authorities | `organization_delegation_authorities` |
| L3 | Stewardship requirement | `organization_stewardship_requirements` (+ `organization_initial_operating_role_grants`) |
| L4 | Tenant capability arrays | `tenant_administrator_assignments.capability_keys text[]` |
| L5 | A configured operator | the `p_operator_actor_id` / cluster-scoped receipt path on `accepted_administration_receipts` |

Each ledger has its own writers, readers, continuity counters, idempotency receipts and safeguards. The readers of L1 and L2 are duplicated across `evaluate_permission_role_path_internal`, `evaluate_organization_permission_eligibility`, `evaluate_organization_delegated_management_eligibility`, `evaluate_organization_record_permission_eligibility_internal` and `organization_has_permanent_steward`. This duplication is the maintenance risk the issue names.

**Target:** exact permission identity stays in the role catalogue; **delegation scope travels with the role**; **tenant powers travel with the role**; all human authority is expressed as **one assignment ledger**; the time-bounded distinction that activations provide is produced by a **Kestra approval workflow** that creates a time-bounded assignment. The configured-system operator path stays as infrastructure plumbing, not a sixth human ledger.

---

## 2. Inventory A — role continuity evidence

### 2.1 The nine source fingerprints

Nine `*_fingerprint` columns describe one accepted role's published source. All are `text` matching `^sha256:[a-f0-9]{64}$`.

| # | Column | Table | Meaning | Live writers | Live readers |
| --- | --- | --- | --- | --- | --- |
| 1 | `source_content_fingerprint` | `organization_role_revisions` | exact published application/module content | `coordinate_application_access_change`, `coordinate_organization_role_change` (+ private `_v1_internal`), `revise_organization_role_metadata_for_administration` | `validate_organization_role_revision_evidence`, admin reads |
| 2 | `source_resolution_fingerprint` | `organization_role_revisions` | resolved dependency set of that release | same | same |
| 3 | `source_template_fingerprint` | `organization_role_revisions` | exact supplied role template | same, plus `coordinate_application_access_change` | `protect_application_role_template_continuity`, `validate_application_role_template_continuity_evidence`, `evaluate_organization_permission_eligibility` |
| 4 | `source_catalogue_fingerprint` | `organization_role_revisions` | exact permission catalogue revision | same | `validate_organization_role_revision_evidence` |
| 5 | `accepted_grant_fingerprint` | `organization_role_revisions` | exact accepted permission grant | same | `validate_organization_role_revision_evidence`, `evaluate_permission_role_path_internal` |
| 6 | `activation_policy_fingerprint` | `organization_role_revisions` | exact activation policy identity | `coordinate_organization_role_change` | `evaluate_permission_role_path_internal`, `validate_organization_role_activation_insert` |
| 7 | `derived_source_content_fingerprint` | `organization_roles` | custom-role copy provenance (source content) | `coordinate_organization_role_change` | `protect_organization_role_identity` (immutability), admin reads |
| 8 | `derived_source_resolution_fingerprint` | `organization_roles` | custom-role copy provenance (resolution) | same | same |
| 9 | `derived_source_template_fingerprint` | `organization_roles` | custom-role copy provenance (template) | same | same |

Fingerprints 1–5 are **source/acceptance provenance**. Fingerprint 6 is **policy identity**. Fingerprints 7–9 **duplicate 1–3** on the identity pointer row for custom roles copied from a template.

### 2.2 Continuity numbers and continuity tables

| Item | Where | What it protects | Live readers | Live writers |
| --- | --- | --- | --- | --- |
| `authority_continuity_revision` | `organization_role_revisions` | existing privileged activation cannot gain newly added authority; retained permissions during review | `evaluate_permission_role_path_internal`, `evaluate_organization_delegated_management_eligibility`, `evaluate_organization_record_permission_eligibility_internal` | `coordinate_organization_role_change` |
| `policy_continuity_revision` | `organization_role_revisions` | old activation requests/windows do not survive a policy change | same readers, `validate_organization_role_activation_insert` | `coordinate_organization_role_change` |
| `template_continuity_revision` | `organization_role_revisions` | template removed/restored requires fresh acceptance | `coordinate_application_access_change` | same |
| `permission_continuities` | table | one exact owner-qualified permission remains continuously `available` with the same meaning; a break (`unavailable`) or meaning change requires re-acceptance | `evaluate_permission_role_path_internal`, `organization_has_permanent_steward`, `validate_organization_role_revision_evidence` | `coordinate_application_access_change`, `protect_permission_continuity`, `validate_permission_continuity_evidence` |
| `application_role_template_continuities` | table | one supplied application role template remains continuously `available` | `evaluate_organization_permission_eligibility`, `coordinate_application_access_change` | `protect_application_role_template_continuity`, `validate_application_role_template_continuity_evidence` |
| `organization_role_permission_entries.continuity_revision` + `meaning_fingerprint` | table | binds each accepted entry to the exact continuity and meaning it was accepted under | all core readers | role writers |

**Core reader:** `vortex_access.evaluate_permission_role_path_internal(jsonb, timestamptz, jsonb, jsonb, uuid)` is the single shared evidence reader. Its four route branches (direct standing, group standing, direct activation, group activation) join `organization_role_assignments`, `organization_role_activations`, `organization_groups`, `organization_group_memberships` and match activation `authority_continuity_revision`, `policy_continuity_revision`, `activation_policy_*` against the live role revision.

### 2.3 Live reader and writer set (continuity)

- **Writers:** `coordinate_application_access_change`, `coordinate_organization_role_change` (public wrappers) over private `coordinate_application_access_without_stewardship_v1_internal`, `coordinate_role_change_without_stewardship_v1_internal`, `coordinate_private_organization_role_authority_change`, `revise_organization_role_metadata_for_administration`, `retire_organization_role_for_administration`, `adopt_security_and_support_operator_permission_catalogue`, `adopt_shipped_platform_permission_catalogue`; guarded by `protect_organization_role_identity`, `refuse_organization_role_history_mutation`, `validate_organization_role_revision_evidence`, `lock_role_and_refuse_sealed_permission_append`, `lock_role_before_revision_seal`, and the three continuity triggers.
- **Readers:** `evaluate_permission_role_path_internal`, `evaluate_organization_permission_eligibility`, `evaluate_organization_delegated_management_eligibility`, `evaluate_organization_record_permission_eligibility_internal`, `organization_has_permanent_steward`, `read_current_application_role_ids_for_launcher`, and the administration reads `list/read_organization_role_for_administration`, `list/read_application_role_template_for_administration`, `list/read_organization_role_activations_for_administration`, `list/read_organization_role_assignments_for_administration`, `list/read_organization_delegation_authorities_for_administration`.

> **Pending context (do not edit):** PR [#1129](https://github.com/Abzum-NZ/Abzum-Vortex/pull/1129) drops `prepare_organization_role_metadata_change_for_administration` and makes a label/description revision copy every fingerprint forward without advancing the Access version. PR [#1167](https://github.com/Abzum-NZ/Abzum-Vortex/pull/1167) moves the accepted contract version into `vortex_definition.accepted_contract_version(kind)` and rewrites `evaluate_organization_record_access_internal`. Both are read-only context for this record.

---

## 3. Inventory B — the five authority ledgers

### L1 — Assignments with activations

| Element | Table | Live readers | Live writers |
| --- | --- | --- | --- |
| Assignment ledger | `organization_role_assignments` | `evaluate_permission_role_path_internal`, `organization_has_permanent_steward`, `read_organization_role_assignment`, admin reads | `coordinate_organization_role_assignment_change`, private `coordinate_private_organization_role_assignment_grant`, `revoke_organization_role_assignment_for_administration`, `compose_initial_operating_role_grant` |
| Activation ledger | `organization_role_activations` | `evaluate_permission_role_path_internal`, `read_organization_role_activation`, admin reads | `coordinate_organization_role_activation_change`, `deactivate_organization_role_activation_for_administration` |
| Activation policy | `organization_role_activation_policy_revisions` | `validate_organization_role_activation_insert`, role readers via revision columns | `coordinate_organization_role_change` |

**Checks protected:** assignment state/time bounds; `assignment_kind` compatibility with the role's `assignment_policy`; direct vs Group eligibility; activation window does not exceed eligibility/membership; "eligibility is not active access"; independent approval and recent-authentication requirements; retained permissions during role review (`authority_continuity_revision`); policy change invalidates old windows (`policy_continuity_revision`).

### L2 — Delegation authorities

| Element | Table | Live readers | Live writers |
| --- | --- | --- | --- |
| Delegation authority | `organization_delegation_authorities` | `evaluate_organization_delegated_management_eligibility`, `evaluate_permission_role_path_internal` (bounded scope), `read_organization_delegation_authority`, admin reads, `organization_has_permanent_steward` | `coordinate_organization_delegation_authority_change` (private `coordinate_private_organization_delegation_authority_change`), `revoke_organization_delegation_authority_for_administration`; bounded-permission validation `validate_organization_delegation_bounded_permissions` |

**Checks protected:** a manager cannot grant wider authority than they hold; bounded vs `organization_catalogue` scope; exact owner-qualified permission set stored canonically; delegation cannot be combined into organisation-wide governance; permanent steward must hold a direct non-expiring `organization_catalogue` delegation.

### L3 — Stewardship requirement

| Element | Table | Live readers | Live writers |
| --- | --- | --- | --- |
| Stewardship requirement | `organization_stewardship_requirements` | `assert_organization_has_permanent_steward`, `organization_has_permanent_steward`, `compose_initial_operating_role_grant`, configured tenant/identity lifecycle | `coordinate_organization_stewardship_adoption`, `coordinate_organization_management_application_requirement` |
| Initial operating grant | `organization_initial_operating_role_grants` | `compose_initial_operating_role_grant` (replay only) | same |
| Requirement guard | both tables | `protect_organization_stewardship_requirement` | same |

**Checks protected:** an adopted organisation always keeps at least one active account with a current direct non-expiring standing assignment that carries the 13 minimum platform management permissions plus a direct non-expiring `organization_catalogue` delegation, plus (once IAM is installed) the exact management-application role. A completed owner mutation that would break this is refused.

### L4 — Tenant capability arrays

| Element | Table | Live readers | Live writers |
| --- | --- | --- | --- |
| Tenant administrator assignment | `tenant_administrator_assignments` (`capability_keys text[]`) | `require_current_tenant_capability`, `list_tenant_launcher`, `list_tenant_administrator_assignments`, `tenant_has_permanent_manager`, hierarchy/lifecycle commands, `tenant_administrator_grant_expiry_cap` | `grant_tenant_administrator`, `change_tenant_administrator`, `revoke_tenant_administrator`, `provision_tenant` / configured provisioning |
| Canonical capability set | `tenant_structural_capability_set_is_canonical` | both tenant writers | validation |
| Tenant receipts | `accepted_administration_receipts` (`tenant_id`) | writers (replay) | `grant/change/revoke_tenant_administrator` |

**Checks protected:** seven structural tenant capabilities, canonical order, 1–7 entries, active identity and tenant, time window, permanent tenant manager, and a grant is bounded by the grantor's own authority.

### L5 — Configured operator

| Element | Path | Live readers/writers |
| --- | --- | --- |
| Cluster identity lifecycle | `apply_configured_cluster_identity_lifecycle`, `suspend/reactivate/close_cluster_identity` (`p_operator_actor_id`, `p_cluster_id`) | the configured system supplies the operator actor; receipts use `accepted_administration_receipts.cluster_id` |
| Tenant lifecycle | `apply_configured_tenant_lifecycle`, `suspend_tenant`, `reactivate_tenant` | same |
| Receipts | `accepted_administration_receipts` (`cluster_id`) | replay and idempotency only |

**Checks protected:** a trusted, server-configured operator (not a human role) can suspend/reactivate/close a cluster identity or suspend/reactivate a tenant; it may not act if the affected organisation/tenant would be left without a permanent steward/manager. This is infrastructure plumbing, not a human authority ledger.

> Do not confuse L4 with the **commercial capability policy** (`capability_policy_definitions`, `capability_policy_assignments`, `capability_reservations`), which is [15 Entitlements and metering](../specification/15-entitlements-and-metering.md) and is out of scope here.

---

## 4. Comparison — today versus the target

| Concern | Today | Target |
| --- | --- | --- |
| Permission identity | catalogue entry + `permission_continuities` + `meaning_fingerprint` | unchanged |
| Role provenance | nine fingerprints copied on the role and its identity row | exact source evidence kept once as an acceptance receipt; identity columns only |
| Delegation | separate `organization_delegation_authorities` ledger | **role-carried delegation**: a management role's entries declare the scope; the assignment carries the grant |
| Tenant powers | `tenant_administrator_assignments.capability_keys[]` | **tenant-scoped ordinary role**, granted through the one assignment ledger |
| Time-bounded privileged use | activation ledger + policy ledger + two continuity counters | **time-bounded ordinary assignment** created by a mandatory Kestra approval workflow |
| Approvals | `independent_approval_required` + approver checks in core | **Kestra backend workflow only** (owner decision) |
| Stewardship | stored requirement row plus initial-grant ledger | **derived invariant** over the one assignment ledger |
| Configured operator | `p_operator_actor_id` receipts | unchanged (infrastructure), not a human ledger |
| Assignment ledger | `organization_role_assignments` (organisation scope) | one ledger, extended to tenant scope and delegation, time-bounded, Groups supported |

The fixed rule that survives every removal is Decision 11's: *a grant operation refuses any role or role template containing a permission outside the actor's current delegated scope.* That single rule replaces both the delegation-ledger subset enforcement and the tenant-capability grant bound.

---

## 5. Agreed removal list

Every item names the check that replaces it; no check is weakened.

| # | Remove | Replaced by (the check that preserves it) |
| --- | --- | --- |
| R1 | `organization_role_activations` table and all activation reads | A **time-bounded assignment** (existing `starts_at`/`expires_at`) created only after the mandatory Kestra approval workflow. The reader already honours assignment time bounds; expiry is immediate and does not wait for Kestra. |
| R2 | `organization_role_activation_policy_revisions`, `assignment_policy`, `activation_policy_id/revision/fingerprint`, `independent_approval_required` | Policy (duration, reason, authentication, approval) becomes the **Kestra workflow definition**; recent-authentication evidence is still enforced at the protected operation by [identity evidence #276](../specification/04-access-and-permissions.md). |
| R3 | `authority_continuity_revision` | Existing **retained-permission rule** already enforced by `permission_continuities` + `organization_role_permission_entries`: a removed permission stops contributing immediately; a returned permission stays `unavailable` until re-accepted. |
| R4 | `policy_continuity_revision` | No core policy period exists once policy lives in the workflow; a grant produced by the current workflow revision is the only authority. |
| R5 | `organization_delegation_authorities` table, `validate_organization_delegation_bounded_permissions`, delegation admin reads/writes | **Role-carried delegation**: the management role's exact permission entries are the scope; the Decision 11 subset rule is checked when the role is accepted and when the assignment is granted. |
| R6 | `organization_stewardship_requirements` stored row (including `management_application_*`) as authority | **Derived invariant** over the one assignment ledger: for every active organisation, there exists a direct, non-expiring, standing assignment carrying the minimum management permissions and the management-application role. The query moves from `organization_has_permanent_steward` to the assignment ledger. |
| R7 | `organization_initial_operating_role_grants` as an authority ledger | Retained only as a **provenance receipt** (one bounded first-owner setup); its authority is the ordinary role/assignment it creates. |
| R8 | `tenant_administrator_assignments.capability_keys text[]` and `tenant_structural_capability_set_is_canonical` | A **tenant-scoped ordinary role** whose entries are the structural capabilities, granted through the one assignment ledger; `require_current_tenant_capability` reads the assignment instead of the array. |
| R9 | `application_role_template_continuities` table and `template_continuity_revision` | **Re-derived** from the current `permission_registration_revisions` + `permission_catalogue_entries` for the exact `source_role_id`/`source_template_fingerprint`; a missing template still makes the role unavailable (open question O3). |
| R10 | `derived_source_content_fingerprint`, `derived_source_resolution_fingerprint`, `derived_source_template_fingerprint` on `organization_roles` | Duplicates of the revision source evidence; custom-role copy provenance is retained once as an acceptance receipt. |
| R11 | `source_content_fingerprint`, `source_resolution_fingerprint`, `source_template_fingerprint` as **identity** inputs | Permission identity is already application context + owner kind + owner id + permission id + continuity revision + meaning fingerprint ([Groups and privileged role access](../specification/appendices/groups-and-privileged-access.md#retained-permissions-during-role-review)). These three remain as receipt evidence only. |

**Nothing weakened — the surviving guarantees:** exact permission identity and meaning; continuity across removal/restore; Group membership evaluated per request; grantor-bounded grants (Decision 11 fixed rule + `tenant_administrator_grant_expiry_cap` semantics); immediate revocation and expiry; recent-authentication at protected operations; permanent steward and permanent tenant manager; no self-grant; no grant wider than the grantor.

---

## 6. Migration order

Dependency-safe, additive-then-switch-then-remove. This is a new application, so no V1/V2 adapter or dual-write period is required ([roadmap](../build-plan/README.md#current-representation)); only enough dual-read to prove the replacement before removal.

1. **Carry delegation scope on the role.** Add an explicit bounded-management marker/scope to `organization_role_revisions`; validate it against permission entries. Extend the Decision 11 subset check to role acceptance. (Additive; no behaviour change.)
2. **Extend the assignment ledger.** Add tenant scope and delegation-scope columns to `organization_role_assignments`, keeping organisation rows unchanged. (Additive.)
3. **Backfill activations to time-bounded assignments** from the live role/policy/eligibility evidence; verify every non-revoked, unexpired activation has a corresponding assignment window. Switch `evaluate_permission_role_path_internal` to the assignment-only routes; keep activation tables read-only.
4. **Backfill delegation authorities** into delegated management roles + assignments; switch `evaluate_organization_delegated_management_eligibility` and `organization_has_permanent_steward` to the role/assignment model; then drop the delegation ledger.
5. **Derive stewardship and tenant-manager invariants** from assignments; remove stored-requirement dependencies from the public wrappers; keep the marker only if O2 requires it, otherwise drop `organization_stewardship_requirements`.
6. **Move tenant capabilities** to tenant-scoped roles/assignments; switch `require_current_tenant_capability`, `tenant_has_permanent_manager`, `list_tenant_*`; then drop `capability_keys`.
7. **Collapse source fingerprints** to identity + receipt; switch `validate_organization_role_revision_evidence`; remove the duplicate columns; re-derive template continuity.
8. **Retire the activation tables and policy ledger last**, after all readers are assignment-only.

Ordering constraints: steps 3 and 4 must complete before step 8; step 1 before step 4; step 6 independent of 3–5.

---

## 7. Open questions for the owner

1. **Kestra availability contract.** With approvals moved to Kestra, is a protected grant *refused* whenever Kestra is unavailable, or may an already-approved workflow retry? The answer decides whether a small "workflow execution reference" must be recorded on the assignment (recommended) or nothing at all.
2. **Tenant scope of the one ledger.** Tenant structural authority is deliberately separate from organisation roles ([04](../specification/04-access-and-permissions.md#roles)). Confirm the target is a **tenant-scoped ordinary role** (new role scope) rather than keeping a distinct tenant concept. Without this, R6/R8 cannot be scheduled.
3. **Template absence.** When a template is withdrawn but its exact permissions remain available through another application, the spec currently makes the role unavailable. Confirm that re-deriving template presence from the current registration/release satisfies that rule, or keep a small template-presence record.
4. **Minimum-management set.** `organization_has_permanent_steward` currently asserts the platform catalogue has exactly 13 required permissions. Confirm that count moves to the derived invariant, so adding a steward permission is a role-change decision, not a code change.
5. **Security/support operator roles.** `adopt_security_and_support_operator_permission_catalogue` already registers the three operator permissions as ordinary catalogue entries. Confirm no operator-specific table is intended; support access then becomes a time-bounded ordinary assignment produced by the Kestra approval workflow.

---

## 8. Out of scope

- No code, SQL, migration, test, build, typecheck, lint, database execution, hosted check, Kestra flow or deployment is produced here.
- No permission or repository-protection change.
- No edit to PR #1129, PR #1167 or any other lane's files; they are pending context only.
- Commercial capability policy (entitlements/metering) is a different concept and is untouched.

## 9. Acceptance mapping

| Issue acceptance | Where satisfied |
| --- | --- |
| Inventory each role continuity fingerprint with its live readers/writers | §2.1 |
| Inventory each of the five ledgers with its live readers/writers | §3 |
| State what each element protects | §2.2, §3, "Checks protected" rows |
| Compare with role-carried delegation and tenant powers plus one assignment ledger | §4 |
| Removal list where every item names the replacing check (nothing weakened) | §5 |
| Migration order | §6 |
| Open questions for the owner | §7 |
