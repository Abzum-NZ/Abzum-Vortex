# Authority ledgers and role continuity — design record (25 September 2026)

**Status:** Decision record for the product owner. Document only: this issue adds no code, SQL or migration. The [architecture freeze and owner decisions of 24–25 September](architecture-decisions-2026-09-25.md) apply.

**Issue:** [#1072](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1072). It compares role continuity evidence and the five authority ledgers with a target of ordinary roles, role-carried delegation and tenant powers, and one assignment ledger. It then lists what can be removed without weakening any check.

**Baseline:**
- Live SQL on `main` after #1053 (required caller), #1048 (tenant actor from the request context) and #993/#1167 (contract-version helper). "Live" means the last definition of each function, including in-place `pg_get_functiondef` rewrites and the canonical files under `supabase/schemas/`.
- [04 Access and permissions](../specification/04-access-and-permissions.md).
- [Groups and privileged role activation](../specification/appendices/groups-and-privileged-access.md) and the [IAM application](../specification/appendices/iam-application.md), both as updated by the merged specification #1052.
- [Architecture decisions](architecture-decisions-2026-09-25.md), Decision 11.

**Binding owner decisions (2026-09-24):**
1. The security operator and support operator are ordinary role templates, assignable to any user in the organisation. They are not a special actor class.
2. All approvals are backend workflows configured in Kestra. Core keeps no approval field and no approver check. When an approval must be unavoidable, the operation's policy names its only permitted caller: a published flow execution binding (#1053, built). One rule is fixed: a grant refuses any role or role template containing a permission outside the actor's own delegated scope (Decision 11).

---

## 0. Decisions for the owner (coordinator: please relay)

The inventory below shows that, on current `main`, only a small set can be removed without weakening a check or changing a merged specification (§5.1). The larger simplifications the issue names each need an owner decision, because each changes the current specification:

| # | Question | Why it needs the owner | Recommendation |
| --- | --- | --- | --- |
| Q1 | **Role-carried delegation.** Should `organization_delegation_authorities` be replaced by management roles that carry a separate declared delegation scope, granted through ordinary assignments (§5.2 B1)? | Spec 04 (Roles → managing access) makes delegation a separate per-holder grant: its own scope, its own window and in-place scope replacement. A role-carried scope changes that for every holder of the role at once. | Adopt only with the B1 conditions: the delegation scope is **separate from use permissions** and needs its own acceptance, and the permanent steward still needs a direct, account-held, non-expiring organisation-catalogue scope. Otherwise keep the ledger. |
| Q2 | **Tenant powers as a tenant-scoped ordinary role.** Should `tenant_administrator_assignments.capability_keys` become a tenant-scoped role granted through the one assignment ledger (§5.2 B2)? | Spec 04 lines 99, 174 and 422 say tenant structure authority is separate and "never arrive[s] through an organisation role". A new tenant role scope would change the role model and the assignment ledger's organisation key. | **Keep the current tenant ledger.** It is small (7 fixed keys) and already grantor-bounded. Revisit only if tenant powers need to become configurable. |
| Q3 | **Fold activations into time-bounded assignments.** Should privileged activation be replaced by a time-bounded standing assignment created by a Kestra flow (§5.2 B3)? | Merged spec #1052 keeps eligibility and activation. Eligibility grants nothing. The beneficiary activates for themselves and can deactivate at once. Activations pin the originating membership. Policy and authority continuity end old windows. | **Keep activations.** #1053 has already removed the approval part, which was the only piece the owner decisions required removing. |
| Q4 | **Minimum steward permission set.** `organization_has_permanent_steward` hard-codes 13 platform permissions by identity and meaning fingerprint. Should that set move into catalogue data, so that adding a steward permission becomes a catalogue release instead of a SQL change? | This changes how the safeguard is defined, not what it enforces. | Optional. Do it only with a catalogue-release check that the set is never empty or reduced silently. |

Once the owner answers, the agreed list is §5.1 plus whichever §5.2 items are accepted. The retained items (§5.3) are not open questions: removing any of them would weaken a check the merged specification requires.

---

## 1. The problem in one page

One organisation role carries **nine source fingerprints**: six on each `organization_role_revisions` row and three on the `organization_roles` identity row. Authority is held in **five places**:

| # | Ledger | Tables |
| --- | --- | --- |
| L1 | Assignments with activations | `organization_role_assignments`, `organization_role_activations`, `organization_role_activation_policy_revisions` |
| L2 | Delegation authorities | `organization_delegation_authorities` |
| L3 | Stewardship requirement | `organization_stewardship_requirements` (+ the setup receipt `organization_initial_operating_role_grants`) |
| L4 | Tenant capability arrays | `tenant_administrator_assignments.capability_keys text[]` |
| L5 | Configured operator | no table: the `p_operator_actor_id` / `p_cluster_id` arguments supplied by the configured runtime, plus the receipts they write in `accepted_administration_receipts` |

**Where the duplication actually is.**
- The four authority routes (direct standing, Group standing, direct activation, Group activation) are evaluated in `vortex_access.evaluate_permission_role_path_internal`. `read_current_application_role_ids_for_launcher` keeps its own copy of the same four routes and continuity matching.
- Delegation is read separately in `evaluate_organization_permission_eligibility` (authority kind `delegated_management`), `organization_has_permanent_steward` and `organization_group_reduction_authority`.
- There is no function called `evaluate_organization_delegated_management_eligibility`. That name belongs only to a migration file.

---

## 2. Inventory A — role continuity evidence

Abbreviations for the direct writers:
- **RoleInt** — `coordinate_role_change_without_stewardship_v1_internal` (live body in `20260925050000`, canonical file under `supabase/schemas/vortex_access/`).
- **AppInt** — `coordinate_application_access_without_stewardship_v1_internal`: the original `coordinate_application_access_change` body, renamed in `20260906033309`.
- **StewAdopt** — `coordinate_organization_stewardship_adoption`.
- **ConnCat** — `adopt_connection_administration_permission_catalogue`.

The public `coordinate_organization_role_change` and `coordinate_application_access_change` are steward-check wrappers. They write nothing directly. So do their callers: `revise_organization_role_metadata_for_administration`, `retire_organization_role_for_administration` and `coordinate_private_organization_role_authority_change`.

### 2.1 The nine source fingerprints

Every fingerprint is `text` in the form `sha256:` followed by 64 hex characters.

| # | Column (table) | Meaning | Direct writers | Direct readers | Check it protects |
| --- | --- | --- | --- | --- | --- |
| 1 | `source_content_fingerprint` (revisions) | exact published release content | RoleInt, AppInt, StewAdopt, ConnCat | `validate_organization_role_revision_evidence`; RoleInt's "acceptance must change evidence" comparison | an application role is bound to one exact release |
| 2 | `source_resolution_fingerprint` (revisions) | resolved dependency set of that release | same | same | same, for bound modules |
| 3 | `source_template_fingerprint` (revisions) | exact supplied role template | same | `application_access_current_state_matches_candidate`, RoleInt, AppInt | a template change is detected and needs acceptance |
| 4 | `source_catalogue_fingerprint` (revisions) | exact permission catalogue revision | same | `validate_organization_role_revision_evidence`, RoleInt | acceptance names the catalogue it was made against |
| 5 | `accepted_grant_fingerprint` (revisions) | the exact explicit acceptance decision | same (required on `accept_new_application_role` / `accept_application_role_revision`) | RoleInt only | an explicit acceptance must change accepted evidence (it cannot replay an older acceptance) |
| 6 | `activation_policy_fingerprint` (revisions) | exact activation policy identity | same | `evaluate_permission_role_path_internal`, `validate_organization_role_activation_insert`, `protect_organization_role_activation`, `validate_organization_role_revision_evidence`, `coordinate_organization_role_activation_change`, `read_current_application_role_ids_for_launcher`, `read_organization_role_activation`, administration reads, `prepare_organization_role_metadata_change_for_administration`, `project_organization_role_change_summary` | an activation is bound to the exact policy it satisfied |
| 7–9 | `derived_source_content/resolution/template_fingerprint` (`organization_roles`) | where a custom role was copied from (copy provenance) | RoleInt, StewAdopt | `protect_organization_role_identity` (immutability only); returned in `derivedFromTemplate` in RoleInt's role result | **none**: no access decision reads them |

Fingerprints 1–5 are acceptance provenance, and several of them feed the acceptance checks in RoleInt and AppInt. Fingerprint 6 is policy identity. Fingerprints 7–9 are display provenance only.

### 2.2 Continuity numbers and continuity tables

| Item | Where | Check it protects | Direct writers | Direct readers |
| --- | --- | --- | --- | --- |
| `authority_continuity_revision` | `organization_role_revisions`; copied onto `organization_role_activations` | Newly accepted, added or restored authority never enters an existing activation window. Narrowing keeps the window (appendix: "authority continuity number"). | RoleInt, AppInt, StewAdopt, ConnCat; `coordinate_organization_role_activation_change` copies it onto activations | `evaluate_permission_role_path_internal`, `validate_organization_role_activation_insert`, `protect_organization_role_activation`, `validate_organization_role_revision_evidence`, `read_current_application_role_ids_for_launcher`, `read_organization_role_activation` |
| `policy_continuity_revision` | same two tables | A policy change ends old requests and windows. Returning from policy A to B and back to A starts a new period instead of reviving old windows. | same | same |
| `template_continuity_revision` | `organization_role_revisions` | Removing and restoring a template needs fresh acceptance. | RoleInt, AppInt, StewAdopt, ConnCat | `application_access_current_state_matches_candidate` |
| `permission_continuities` | table | An exact owner-qualified permission stays continuously `available` with the same meaning. A break or a meaning change needs re-acceptance. | AppInt, StewAdopt, ConnCat, `adopt_shipped_platform_permission_catalogue`, `adopt_security_and_support_operator_permission_catalogue`; guarded by the triggers `protect_permission_continuity` and `validate_permission_continuity_evidence` | `evaluate_permission_role_path_internal`, `organization_has_permanent_steward`, `evaluate_organization_permission_eligibility`, `validate_organization_role_activation_insert`, `coordinate_organization_role_activation_change`, application-access match/complete helpers, `validate_organization_delegation_bounded_permissions`, the catalogue exactness checks |
| `application_role_template_continuities` | table | One supplied template stays continuously `available`. A missing template makes the role unavailable. | AppInt; guarded by the triggers `protect_application_role_template_continuity` and `validate_application_role_template_continuity_evidence` | `application_access_current_state_matches_candidate`, `application_access_current_transition_is_complete`, RoleInt, `list_application_role_templates_for_administration`, `read_application_role_template_for_administration` |
| `organization_role_permission_entries.continuity_revision` + `meaning_fingerprint` | table | Each accepted entry is bound to the continuity and meaning it was accepted under. | RoleInt, AppInt, StewAdopt, ConnCat | `evaluate_permission_role_path_internal`, `organization_has_permanent_steward`, `validate_organization_role_activation_insert`, `validate_organization_role_revision_evidence`, `coordinate_organization_role_activation_change` |

Role storage is also guarded by `protect_organization_role_identity`, `refuse_organization_role_history_mutation`, `validate_organization_role_revision_evidence`, `lock_role_and_refuse_sealed_permission_append` and `lock_role_before_revision_seal`.

**Pending context, not edited here:**
- Open PR #1129 (display-only role and Group renames) drops `prepare_organization_role_metadata_change_for_administration` and carries every fingerprint forward on a label or description revision. It changes no ledger.
- #1167 (merged) moved the accepted contract version into `vortex_definition.accepted_contract_version(kind)`. It does not touch these ledgers.

---

## 3. Inventory B — the five authority ledgers

### L1 — Assignments with activations

| Element | Direct writers | Direct readers |
| --- | --- | --- |
| `organization_role_assignments` | `coordinate_assignment_change_without_stewardship_v1_internal`, StewAdopt. The public `coordinate_organization_role_assignment_change`, `coordinate_private_organization_role_assignment_grant`, `revoke_organization_role_assignment_for_administration` and `compose_initial_operating_role_grant` all go through the public wrapper. | `evaluate_permission_role_path_internal`, `read_current_application_role_ids_for_launcher`, `organization_has_permanent_steward`, `coordinate_organization_role_activation_change`, `read_organization_role_assignment`, `read_organization_role_assignment_for_administration` and the list read, `prepare_organization_role_metadata_change_for_administration` |
| `organization_role_activations` | `coordinate_organization_role_activation_change` (16 arguments since #1053; owner-only; its only live SQL caller is `deactivate_organization_role_activation_for_administration`) | `evaluate_permission_role_path_internal`, `read_current_application_role_ids_for_launcher`, `read_organization_role_activation`, `list_/read_organization_role_activation(s)_for_administration` |
| `organization_role_activation_policy_revisions` | RoleInt | `coordinate_organization_role_activation_change`, `validate_organization_role_activation_insert`, `list_/read_organization_role(s)_for_administration`, `read_organization_role_activation_for_administration`, `project_organization_role_change_summary` |

**Checks protected, live after #1053:**
- The assignment's kind (`standing` or `eligible`) matches the role's `assignment_policy`. Eligibility grants nothing.
- Direct and Group routes are never mixed.
- An activation needs:
  - the current role and policy, matched by exact fingerprint;
  - an active account;
  - a current eligible assignment and, where Group-derived, a current Group and membership;
  - a duration no longer than the policy maximum and the eligibility or membership end.
- **Required caller.** When `required_caller_execution_binding_id` is set, the invoking execution binding must equal it. The binding must be current, active, unexpired and in the same organisation, and its run-as actor must be the changer. Otherwise the call is refused with the error "requires its named caller".
- `independent_approval_required` no longer exists: #1053 dropped it.
- The policy still stores `reason_required` and the authentication requirement. The core activation writer does not recheck them. Per #1052 the protected invocation (#40/#267) must recheck them before activation is exposed. This is existing planned scope, not a gap this record adds.

### L2 — Delegation authorities

| Element | Direct writers | Direct readers |
| --- | --- | --- |
| `organization_delegation_authorities` | `coordinate_delegation_change_without_stewardship_v1_internal`, reached only through the steward-check wrapper `coordinate_organization_delegation_authority_change` (callers: `coordinate_private_organization_delegation_authority_change`, `revoke_organization_delegation_authority_for_administration`); StewAdopt inserts the steward's catalogue delegation. Triggers: `validate_organization_delegation_authority` (calls `validate_organization_delegation_bounded_permissions`) and `protect_organization_delegation_authority`. | `evaluate_organization_permission_eligibility` (`delegated_management`), `organization_has_permanent_steward`, `organization_group_reduction_authority`, `coordinate_private_organization_delegation_authority_change`, `read_organization_delegation_authority`, `list_/read_organization_delegation_authorit(ies/y)_for_administration`, `project_organization_delegation_summary` |

`evaluate_permission_role_path_internal` and `evaluate_organization_record_permission_eligibility_internal` do **not** read delegation. The record reader refuses a delegated context.

**Checks protected:**
- A holder is one account or one Group.
- The scope is `organization_catalogue` (no permission list) or `bounded`: a non-empty, canonical, exact owner-qualified permission list with a fingerprint, each permission currently `available`.
- Identity and time window are immutable. Rows cannot be deleted. A new row starts live at revision 1.
- Delegated management needs a complete current delegation route for every before-and-after permission.
- Organisation-catalogue governance needs an actual catalogue delegation, per spec 04. The live evaluator accepts exactly one authority kind per declaration.
- Delegation grants **no use** of the delegated permissions (spec 04). This is how the steward assigns the first application role without seeing its data.

### L3 — Stewardship requirement

| Element | Direct writers | Direct readers |
| --- | --- | --- |
| `organization_stewardship_requirements` | StewAdopt (insert at adoption: through `provision_tenant`, `adopt_organization` or `create_tenant_organization`); `coordinate_organization_management_application_requirement` (sets the management-application fields once; `compose_initial_operating_role_grant` calls it) | `organization_has_permanent_steward`, `assert_organization_has_permanent_steward`, `compose_initial_operating_role_grant`, `adopt_organization`, `apply_configured_cluster_identity_lifecycle`, `apply_configured_tenant_lifecycle`, `reactivate_tenant_organization` |
| Guard | `protect_organization_stewardship_requirement` (on this table only) | — |
| `organization_initial_operating_role_grants` | `compose_initial_operating_role_grant` only (`vortex_runtime`; no trigger, protected by grants and its primary key) | the same function, for replay with an identical manifest |

**Checks protected.** The row is not just a record of history. Its presence switches the safeguard on: `assert_organization_has_permanent_steward` returns early for an organisation that has not been adopted, and spec 04 keeps protected administration unavailable until adoption. The row also names the required management application and role revision. For an adopted organisation, at least one account must meet all of these:
- the account and its identity are active;
- it has a direct, live, started, non-expiring `standing` assignment to an `active` standing role;
- that role carries all 13 pinned platform permissions, each `available` at the current registration;
- it holds a direct, account-held, live, non-expiring `organization_catalogue` delegation;
- once required, it has a direct, standing, non-expiring assignment to the management-application role, whose required revision's permissions are all still available.

`assert_…` runs after adoption and after every role, assignment, delegation, account-state and application-access write.

### L4 — Tenant capability arrays

| Element | Direct writers | Direct readers |
| --- | --- | --- |
| `tenant_administrator_assignments.capability_keys` | `grant_tenant_administrator`, `change_tenant_administrator`, `revoke_tenant_administrator` (actor from `tenant_request_actor_id()`, since #1048), `provision_tenant`, `adopt_tenant` | `require_current_tenant_capability` (used by the hierarchy, organisation and assignment commands), `tenant_has_permanent_manager`, `tenant_administrator_grant_expiry_cap`, the grant/change subset check, `list_tenant_administrator_assignments`, both `apply_configured_*_lifecycle` functions. `list_tenant_launcher` reads the assignment row but not the keys. |
| Canonical set | enforced by the table check `tenant_administrator_assignments_capabilities_valid` and by `tenant_capabilities_from_json` (grant and change) using `tenant_structural_capability_set_is_canonical` | — |
| Tenant receipts (`accepted_administration_receipts.tenant_id`) | the three writers above, every hierarchy and lifecycle command, `adopt_tenant`, `adopt_organization` | replay, and the adoption precondition of the permanent-manager check (L5) |

**Checks protected:**
- The seven structural keys (`platform.tenant.administrators.manage` / `.administrators.read` / `.hierarchy.read` / `.organizations.create` / `.organizations.lifecycle` / `.organizations.rename` / `.organizations.reparent`) are held as 1–7 entries in strictly ascending order.
- The actor comes from the request context and must be an active human or federated identity.
- Grant and change refuse a self-grant, and every key must be in the actor's own effective keys.
- Expiry is capped at the actor's latest expiry, including for `administrators.manage`.
- Change and revoke keep a permanent tenant manager.
- Tenant structure authority grants no organisation-data access.

### L5 — Configured operator

This is not a stored identity:
- The configured runtime supplies `p_operator_actor_id` from `VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID` and `p_cluster_id` from `VORTEX_CLUSTER_ID` (`runtime/identity/src/configured-tenant-administration.ts`, kind `configured_system_operator`).
- The database checks only that each is a non-nil UUID. Trust comes from `EXECUTE` being granted only to `vortex_runtime`.

| Operation | Operator arguments | Receipt scope |
| --- | --- | --- |
| `provision_tenant` | `p_cluster_id`, `p_operator_actor_id` | `cluster_id` |
| `adopt_tenant`, `adopt_organization` | `p_operator_actor_id` | `tenant_id` |
| `apply_configured_cluster_identity_lifecycle` (+ `suspend/reactivate/close_cluster_identity`) | both | `cluster_id` |
| `apply_configured_tenant_lifecycle` (+ `suspend_tenant`, `reactivate_tenant`) | both | `tenant_id` |

**Checks protected:**
- Only the configured runtime can provision, adopt or apply a lifecycle change.
- Cluster identity lifecycle rechecks the organisation steward and the tenant manager after the update.
- Tenant lifecycle rechecks both only on reactivate.
- Receipts are more than a replay store. The permanent-manager check runs only for tenants with an `adopt_tenant` receipt or a cluster-scoped `provision_tenant` receipt.

L5 is unrelated to the security and support operators, which are ordinary role templates (`adopt_security_and_support_operator_permission_catalogue` registers three ordinary catalogue entries that no role receives automatically).

> Out of scope: the commercial capability policy (`capability_policy_*`, `capability_reservations`, [15 Entitlements](../specification/15-entitlements-and-metering.md)).

---

## 4. Comparison — today versus the target

| Concern | Today | Target the issue proposes | Verdict |
| --- | --- | --- | --- |
| Approval | activation-policy flag + approver checks | Kestra flow; optional required caller | **Done by #1053.** No approval field remains. |
| Permission identity | catalogue + `permission_continuities` + entry continuity/meaning | unchanged | keep |
| Role acceptance provenance | source fingerprints 1–5 on each revision | acceptance evidence kept once | Already kept once per revision. Fingerprints 1–5 feed the acceptance checks, so keep them. |
| Custom-role copy provenance | fingerprints 7–9 on the identity row | not needed for authority | **remove** (§5.1 A1) |
| Route evaluation | one evaluator plus a copy in the launcher | one evaluator | **deduplicate** (§5.1 A2) |
| Delegation | separate per-holder ledger | role-carried scope, granted through assignments | owner decision Q1 (§5.2 B1) |
| Tenant powers | `capability_keys` array | tenant-scoped ordinary role | owner decision Q2 (§5.2 B2); conflicts with spec 04 |
| Privileged time-bounded use | eligibility + activation + policy + two continuity numbers | time-bounded assignment | owner decision Q3 (§5.2 B3); conflicts with #1052; recommend keep |
| Stewardship | requirement row as adoption marker + derived check | derived invariant over assignments | The rule is already derived. The row stays as the adoption marker and management-application requirement (§5.3). |
| Configured operator | runtime-configured, unstored | unchanged | keep: infrastructure, not a human ledger |

The fixed Decision 11 rule survives every option: a grant refuses a role or template containing a permission outside the actor's own delegated scope.

---

## 5. Removal list

### 5.1 Removable now — nothing weakened, no specification change

| # | Remove | Why no check is weakened / what replaces it |
| --- | --- | --- |
| A1 | `organization_roles.derived_source_content_fingerprint`, `derived_source_resolution_fingerprint`, `derived_source_template_fingerprint`, and their three fields in the role result's `derivedFromTemplate` | No access decision, safeguard or acceptance check reads them. Their only other reader is the immutability trigger `protect_organization_role_identity`, which protects nothing else through them. The copy source stays identified by `derived_source_role_id`, `derived_application_root_id`, `derived_source_definition_key` and the release revision/version columns. Those name one immutable published release, so its exact content, resolution and template evidence can still be looked up from the release itself. This changes the role result's `derivedFromTemplate` object, so update [data contracts](../specification/appendices/data-contracts.md) in the same change. |
| A2 | The duplicate four-route and continuity matching in `read_current_application_role_ids_for_launcher` | Replace it with a call to `evaluate_permission_role_path_internal`, or a thin role-set form of that evaluator, so there is one route evaluator. The same routes, continuity numbers, policy fingerprints and time bounds apply, and there are fewer places to keep in step. |
| A3 | `independent_approval_required` and every approver check | **Already removed by #1053.** Replaced by the optional required-caller execution binding. Listed only so the record is complete. |

### 5.2 Removable only if the owner agrees (each changes a merged specification)

| # | Remove | Replacement, and the conditions that keep every check |
| --- | --- | --- |
| B1 (Q1) | `organization_delegation_authorities`, its triggers, the private and public delegation writers and reads, `project_organization_delegation_summary` | A management role revision carries a **separate delegation scope**: `organization_catalogue`, or a bounded exact permission list with its fingerprint. It is granted through an ordinary assignment. The following conditions keep every current check:<br>(a) The delegation scope is distinct from the role's use entries: it grants no use, and use grants no delegation.<br>(b) Accepting a delegation scope is its own explicit acceptance, never implied by a use-role acceptance.<br>(c) Published application templates cannot declare `organization_catalogue`.<br>(d) The bounded scope keeps the current validation: canonical, exact, `available`.<br>(e) `evaluate_organization_permission_eligibility`, `organization_has_permanent_steward` and `organization_group_reduction_authority` read the scope through the assignment route, keeping the Group and time-window checks.<br>(f) The steward still needs a direct, account-held, non-expiring catalogue scope.<br>(g) The Decision 11 subset rule is checked at role acceptance and at assignment grant.<br>**Trade-off:** changing a role's scope changes it for every holder, where today each grant is replaced independently. Per-holder scopes then need separate roles. |
| B2 (Q2) | `tenant_administrator_assignments.capability_keys` and the tenant grant writers | A tenant-scoped ordinary role whose entries are the seven structural keys, granted through an assignment ledger that accepts a tenant scope. It must keep the self-grant refusal, the actor-subset and expiry caps, the permanent tenant manager, the request-context actor, and "grants no organisation-data access". Requires changing spec 04 (lines 99, 174, 422) and adding a tenant key to the assignment ledger. **Not recommended now.** |
| B3 (Q3) | `organization_role_activations`, and eligibility as an assignment kind | A time-bounded standing assignment created by a flow. **Not recommended.** It would lose the following, all required by #1052:<br>• eligibility granting nothing<br>• self-activation by the authenticated beneficiary<br>• immediate self-deactivation<br>• originating-membership pinning (removing the membership ends the window)<br>• policy and authority continuity ending old windows<br>Recreating them on assignments would rebuild the activation ledger under another name. |

### 5.3 Retained — removing would weaken a check

| Item | The check it alone provides |
| --- | --- |
| `authority_continuity_revision` (revisions and activations) | New or restored authority never enters an existing activation window, while narrowing keeps it. `permission_continuities` is per-permission and cannot detect a role-level addition. |
| `policy_continuity_revision` (revisions and activations) | Policy A → B → A starts a new period. Pinning the policy revision alone would revive old windows when an exact earlier reference returns. |
| `organization_role_activation_policy_revisions` | Holds the duration, reason and authentication settings #1052 keeps, and now the required caller (#1053). |
| `template_continuity_revision` + `application_role_template_continuities` | A withdrawn and restored template needs fresh acceptance (spec 04). Re-deriving presence from the current release cannot tell "restored" from "never withdrawn". |
| `permission_continuities` + entry `continuity_revision`/`meaning_fingerprint` | Exact permission identity and meaning (unchanged target). |
| Source fingerprints 1–5 | Bind each application acceptance to one exact release, resolution, template, catalogue and acceptance decision. Read by `validate_organization_role_revision_evidence` and the acceptance comparisons in RoleInt and AppInt. |
| Activation-policy fingerprint (6) | Binds each activation to the exact policy it satisfied. |
| `organization_stewardship_requirements` | Marks adoption, which switches the safeguard on, and names the required management application and role revision. The steward rule itself is already derived from assignments, delegation and continuity. |
| `organization_initial_operating_role_grants` | Exactly-once replay of first-steward setup with an identical manifest. It is a receipt, not an authority source. |
| Tenant and cluster receipts | Replay, plus the adoption precondition of the permanent-manager check. |
| Configured operator (L5) | Infrastructure trust boundary (`vortex_runtime`). It is not a human authority ledger and is not the security or support operator. |

**Surviving guarantees under any combination of the above:**
- exact permission identity and meaning;
- continuity across removal and restore;
- Group membership checked per request;
- grantor-bounded grants (the Decision 11 subset rule and the tenant subset/expiry caps);
- no self-grant;
- immediate revocation and expiry, without waiting for Kestra;
- the required caller when configured;
- the permanent organisation steward and the permanent tenant manager;
- recent authentication and reason rechecked at the protected invocation (#40/#267).

---

## 6. Migration order

This is a new application. There is no dual-write period, and there is only as much dual-read as needed to prove a switch before a drop. Each step is its own issue and migration. Where a live body was rewritten in place (for example `20260913030000`, `20260915010000`, `20260923180000`, `20260923220000`, `20260923230000`), patch the **live** body in place with an exactly-once guard. Never copy an earlier `create`.

1. **A2 — one route evaluator.** Switch `read_current_application_role_ids_for_launcher` to the shared evaluator. No schema change.
2. **A1 — drop the derived fingerprints.** Remove the columns, their inserts in RoleInt and StewAdopt, their checks in `protect_organization_role_identity`, and the three `derivedFromTemplate` fingerprint fields. Update the data contracts in the same change.
3. **B1, only if Q1 is accepted:**
   1. Add the delegation-scope columns to role revisions, with validation and separate acceptance (additive).
   2. Switch `evaluate_organization_permission_eligibility`, `organization_has_permanent_steward` and `organization_group_reduction_authority` to read the scope from assignments.
   3. Backfill each live delegation into a delegation role plus an assignment, preserving holder, window and scope. The steward's catalogue delegation stays direct, account-held and non-expiring.
   4. Switch StewAdopt and the IAM consumers.
   5. Drop the delegation ledger, its triggers and its reads.
4. **B2, only if Q2 is accepted:** first change spec 04 and add a tenant scope to the assignment ledger. Then move `require_current_tenant_capability`, `tenant_has_permanent_manager`, `tenant_administrator_grant_expiry_cap`, both lifecycle functions and the tenant writers to the role path. Drop `capability_keys` last.
5. **Q4 (optional):** move the 13-permission steward set into catalogue data, with a release-time check that the set is never reduced silently.

Steps 1–2 are independent of each other and of the owner questions. Steps 3 and 4 are independent of each other. B3 has no step, because it is not recommended.

---

## 7. Out of scope

- No code, SQL, migration, test, build, database execution, hosted check, Kestra flow or deployment.
- No permission or repository-protection change.
- PR #1129 is pending context only.
- The commercial capability policy is untouched.

## 8. Acceptance mapping

| Issue requirement | Where |
| --- | --- |
| Each role continuity fingerprint and continuity item, with live readers and writers and the check it protects | §2 |
| Each of the five ledgers, with live readers and writers and the checks they protect | §3 |
| Comparison with role-carried delegation, tenant powers and one assignment ledger | §4 |
| Removal list in which every item names its replacing check, with nothing weakened | §5.1 (now), §5.2 (owner-gated), §5.3 (retained, with the reason) |
| Migration order | §6 |
| Open questions for the owner | §0 |
