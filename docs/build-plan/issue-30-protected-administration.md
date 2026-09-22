# Protected tenant and organisation administration — implementation plan

> Historical design/task record, not a dispatch brief or current fleet instruction. Use the live bounded GitHub issue and [current agent coordination](agent-coordination.md) / [fleet procedure](agent-fleet.md). Any tests, proof receipts, hosted/database verification, fixed model assignments, pickup lists or deployment instructions below are superseded and must not be executed or added to acceptance. Retain relevant product design facts only; the current specification resolves product scope.

Owning task: [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30).
Governing requirements: [people and organisations](../specification/02-people-organisations-and-sign-in.md),
[Access](../specification/04-access-and-permissions.md),
[IAM](../specification/appendices/iam-application.md),
[data contracts](../specification/appendices/data-contracts.md) and
[platform-only core](../specification/appendices/core-contract-boundary.md).

## Status, delivered slices and dependency boundary

Slice 5 and Slice 6 are delivered. [#455](https://github.com/Abzum-NZ/Abzum-Vortex/issues/455)
has delivered its hosted Testing verification prerequisite. Completed prerequisite
history is retained for context only. The hosted delivery of the
[central Access decision #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34)
is [complete](../evidence/issue-34-access-decision.md#delivery-boundary). The other native prerequisites — [#23](https://github.com/Abzum-NZ/Abzum-Vortex/issues/23),
[#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24),
[#26](https://github.com/Abzum-NZ/Abzum-Vortex/issues/26),
[#27](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27),
[#32](https://github.com/Abzum-NZ/Abzum-Vortex/issues/32),
[#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) and
[#224](https://github.com/Abzum-NZ/Abzum-Vortex/issues/224) — are retained for
traceability. No user hold or additional approval gate exists.

This task does not depend on completing every role, Group or PIM operation in
[#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40). Both tasks consume the
same completed Access decision and governance-first ordering, but each owns its
own protected operations. Adding a whole-task dependency would create no useful
code or authority boundary.

This work unlocks [the isolation suite #29](https://github.com/Abzum-NZ/Abzum-Vortex/issues/29),
[administration applications #72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72),
[guided IAM setup #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267),
[account offboarding #407](https://github.com/Abzum-NZ/Abzum-Vortex/issues/407)
and [organisation-bounded record-type lifecycle policies #408](https://github.com/Abzum-NZ/Abzum-Vortex/issues/408).
The latter two consume protected account and organisation facts; neither is a
prerequisite for Slice 6.

Delivered on `testing`:

- **Slice 1** — tenant-administration facts and protected receipt boundary
  ([PR #441](https://github.com/Abzum-NZ/Abzum-Vortex/pull/441)).
- **Slice 2** — trusted configured-system provisioning and explicit adoption
  ([PR #444](https://github.com/Abzum-NZ/Abzum-Vortex/pull/444)).
- **Slice 3A** — human tenant authority, bounded tenant reads, and
  tenant-administrator grant, change and revoke
  ([PR #445](https://github.com/Abzum-NZ/Abzum-Vortex/pull/445)).
- **Slice 3B** — protected display-name rename and same-tenant/root reparent
  ([PR #446](https://github.com/Abzum-NZ/Abzum-Vortex/pull/446)).
- **Slice 3C** — protected organisation lifecycle: suspend, reactivate and
  administrative archive ([PR #448](https://github.com/Abzum-NZ/Abzum-Vortex/pull/448)).
- **Slice 3D** — tenant-authorised organisation creation with explicit existing
  stewardship ([PR #449](https://github.com/Abzum-NZ/Abzum-Vortex/pull/449)).
- **Slice 4A** — configured-system cluster-local identity-projection lifecycle
  ([PR #450](https://github.com/Abzum-NZ/Abzum-Vortex/pull/450)).
- **Slice 4B** — configured-system tenant lifecycle
  ([PR #451](https://github.com/Abzum-NZ/Abzum-Vortex/pull/451)).
- **Slice 5** — organisation-local administrative reads
  ([PR #453](https://github.com/Abzum-NZ/Abzum-Vortex/pull/453)).
- **Slice 6** — organisation-local account lifecycle and invitations
  ([PR #473](https://github.com/Abzum-NZ/Abzum-Vortex/pull/473)).

Slices 1, 2, 3A, 3B, 3C, 3D, 4A, 4B, 5 and 6 are delivered to Testing. The
delivered reads remain context and are not Slice 6 scope.

## Outcome

Provide narrow, typed, channel-neutral protected operations above the existing
private Identity and Access storage:

- trusted initial provisioning, explicit adoption and system-only cluster lifecycle;
- tenant-authorised hierarchy, lifecycle and tenant-administrator operations;
- organisation-authorised account and invitation operations; and
- bounded safe administrative reads and deterministic replay evidence.

Tenant authority is structural only. It never grants organisation membership,
application entry, role authority or data access. Organisation-local operations
require an active organisation account and the exact current organisation
permission decided by [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34).
There is no role-name check, hidden administrator flag, tenant fallback or second
permission evaluator.

The service boundary is intentionally earlier than its user interfaces. A future
Tenant Administration application presents hierarchy and lifecycle; Organisation
Administration presents accounts, invitations and runtime settings; IAM presents
tenant-administrator grants and organisation access-grant journeys. Those locked
ordinary applications belong to [#72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72)
and [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267). This task adds no
page, route, generic form, MCP transport, model, assistant or AI behaviour.

## Authority and transaction boundaries

Tenant-governance operations resolve a verified identity, active cluster
projection, selected tenant and current effective same-tenant administrator
assignments inside the protected transaction. They require one exact capability
from this closed, no-wildcard catalogue:

- `platform.tenant.hierarchy.read`
- `platform.tenant.organizations.create`
- `platform.tenant.organizations.rename`
- `platform.tenant.organizations.reparent`
- `platform.tenant.organizations.lifecycle`
- `platform.tenant.administrators.read`
- `platform.tenant.administrators.manage`

This path deliberately needs no account in the target organisation. That allows
creation of the first organisation and recovery of a suspended organisation. A
later IAM journey additionally needs an active account and operating role in its
chosen IAM instance; that is application entry, not authority for the tenant
command.

Organisation-local reads use the existing [#27](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27)
resolved context and the thin [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34)
adapter. Changing operations first acquire organisation governance, then resolve
and evaluate current authority in the same transaction before invoking the owned
writer. They do not acquire a read resolver's shared lock and later try to upgrade
it. [Lock-order correction #305](https://github.com/Abzum-NZ/Abzum-Vortex/issues/305)
establishes the compatible reader order; no retry or transaction framework is
added here.

```mermaid
flowchart LR
    S[Configured system operator] --> P[Provision or adopt structure]
    P --> I[Create or confirm Identity facts]
    I --> D1[Call delivered stewardship adoption]
    D1 --> R[Commit one accepted receipt]

    T[Verified tenant administrator] --> TG[Tenant authority and governance]
    TG --> TC[Tenant structure or assignment command]
    TC --> R

    O[Verified organisation account] --> G[Lock organisation governance]
    G --> A[Resolve context and call sole Access decision]
    A --> W[Invoke existing owned writer]
    W --> R
```

## Reuse delivered stewardship and Identity work

Provisioning creates or confirms the tenant, organisation, cluster-local identity
projection, active organisation account and Access-version baseline. Inside that
same outer transaction, it calls the Identity-owned initializer from
[#430](https://github.com/Abzum-NZ/Abzum-Vortex/issues/430) with the explicit
runtime-settings values. #430 owns the settings shape, validation, storage,
persistence and internal runtime reader; #30 does not duplicate any of them. It
then invokes the delivered [#33 stewardship adoption](../evidence/issue-33-stewardship/README.md)
inside the same outer transaction. That composition already creates the exact
organisation-owned steward role, direct permanent assignment, organisation-wide
delegation, current stewardship requirement and one Access-version change. Do not
rebuild those rows or add another stewardship evaluator.

The tenant steward and organisation steward are distinct explicit nominations and
receive distinct scoped assignments. The same verified person may be nominated for
both. “Separate” forbids implicit tenant-to-organisation authority; it does not
require two different humans.

Existing live scopes are adopted only by an explicit configured-system command.
No migration guesses a steward from creator, row order, first account or tenant
administrator. Organisation readiness is established by the current delivered
stewardship requirement and its live qualifying facts. Tenant readiness is
established by a current qualifying permanent tenant assignment and its accepted
system command. Do not add a second bootstrap snapshot, history, continuity or
counter.

Structural adoption is not complete IAM availability. The exact management-
application binding delivered by [#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33),
the installed IAM release and the steward's operating role are composed and proven
later by [application integration #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64)
and [guided setup #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267).
Do not report “IAM ready” from a successful
[#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) service operation.

Reuse the existing [#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24)
invitation owner and the guarded account-state composition delivered with
[#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33). Invitation creation in
this task is the no-intent path only. Invitation-time Group or role intent remains
the governed IAM operation owned by [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40)
and [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267).

## Private facts and common command rules

Correct the tenant-administrator assignment contract before adding storage. Each
assignment has a permanent identifier, tenant and verified identity, a canonical
unique nonempty set of closed structural capabilities, fixed start and optional
expiry, positive revision, original grant provenance, current change evidence and
all-or-none revocation evidence. `scheduled`, `active`, `expired` and `revoked` are
derived temporal outcomes, not editable authority. Remove the false Activity
identifier requirement; generic Activity remains with
[#252](https://github.com/Abzum-NZ/Abzum-Vortex/issues/252) and
[#115](https://github.com/Abzum-NZ/Abzum-Vortex/issues/115).

Add two #30-private forced-RLS fact tables: tenant assignments and accepted
administration receipts. [#430](https://github.com/Abzum-NZ/Abzum-Vortex/issues/430)
owns the separate runtime-settings table. Give public, browser, Data API, runtime
and request roles no direct table or raw-helper access. Actors, clocks,
correlations, resolved scopes and permission evidence are trusted server facts,
not editable command fields.

Use one minimal accepted-receipt pattern across successful #30 commands. Scope its
uniqueness by trusted actor, tenant or cluster scope, operation and duplicate key;
bind a canonical input fingerprint and resulting identifiers/revisions. An exact
retry returns the accepted result without another mutation or Access increment;
a changed payload conflicts. Store no raw input document, invitation secret,
credentials, email/profile data, permission snapshot, business value or second
Activity payload. A refused or failed transaction writes no success receipt. This
pattern does not wrap or replace #430's settings initializer or revision-checked
update behaviour.

Creates require duplicate protection but no prior revision. Updates and revocations
also require the exact current revision. Successful results return only the typed
operation and subject identifiers, resulting revision or Access version where
applicable, server correlation and server time. Safe refusals do not reveal whether
a foreign or inactive target exists.

## Build in bounded slices

### 1. Contracts and storage foundation

- Correct the tenant-assignment contract and add strict commands, results, safe
  refusals, operator context, tenant launcher/read models and receipt contracts.
- Reuse #430's canonical language and time-zone validators for organisation-account
  preferences; do not duplicate those validators.
- Add the two #30-private fact tables, their exact owner-only reads and storage
  invariants. Do not add an organisation role table, Access counter, permission
  cache, assignment history or generic policy engine.

### 2. Trusted provisioning and explicit adoption

- Add one server-only configured operator boundary with a non-nil system actor.
- Provision a tenant and root organisation with explicitly nominated tenant and
  organisation stewards, explicit #430 runtime settings, Access baseline and
  active projection and account; invoke delivered stewardship adoption and commit
  one #30 receipt.
- Create a later organisation through the same structural core after tenant
  authorization, always with an explicitly nominated organisation steward. The
  creating tenant administrator receives no organisation role unless separately
  nominated.
- Explicitly adopt pre-existing live tenants and organisations. Readiness refuses
  until every live scope has its supported current stewardship facts.

### 3. Tenant governance and structure

- **Delivered 3A:** tenant launcher and bounded deterministic hierarchy and
  administrator reads; grant, change and revoke tenant assignments with exact
  capability, revision, duplicate and final-manager protection.
- **Delivered 3B:** rename an existing organisation's display name, or reparent an
  existing organisation to a same-tenant parent or to the tenant root. Both use
  the exact `organizations.rename` or `organizations.reparent` capability,
  expected organisation revision, existing tenant serialization, existing
  receipt semantics and a post-wait authority recheck. Reparenting reuses #23's
  same-tenant, self-parent and cycle constraints. It does not alter descendants:
  their existing links make them move with the subtree.
- **Delivered 3C:** suspend, reactivate and administratively archive an existing
  organisation under the lifecycle capability and established structural rules.
- **Delivered 3D:** tenant-authorised creation of one organisation with an explicit
  existing active steward nominee and explicit runtime settings, using delivered
  provisioning composition.
- **Delivered 4A:** configured-system suspension, reactivation and closure of one
  cluster-local identity projection, preserving every affected scope's current
  stewardship requirements.
- **Delivered 4B:** configured-system suspension or reactivation of one tenant,
  preserving its existing readiness facts without rewriting any child scope.

### 4. System-only cluster lifecycle

- **Delivered 4A:** suspend, reactivate and close one cluster-local identity
  projection through the configured system operator with exact revision and
  deterministic replay using the existing configured actor + configured cluster
  + operation + duplicate-key receipt serialization. It discovers its affected
  organisations and tenants, locks existing governance rows `FOR UPDATE`, then
  tenant rows `FOR UPDATE`, then the target projection `FOR UPDATE`, each in
  stable identifier order, rechecks membership, and fails stale rather than
  expanding a lock set or retrying automatically.
- **Delivered 4B:** suspend/reactivate one tenant through the configured system
  operator. It preserves existing organisation/tenant stewardship while leaving
  child organisation state, accounts, assignments and Access versions unchanged.
- Neither slice mutates provider/Auth identity or sessions, another cluster,
  descendant organisation states or organisation Access versions.

## Slice 3B — protected rename and reparent

This slice has exactly two commands. A rename changes only an organisation's
display name. A reparent changes only its parent organisation reference, either
to another organisation in the same tenant or to `null` for a root organisation.
Neither command creates an organisation, changes its permanent identifier,
short name, tenant, lifecycle, accounts, local roles, record ownership or Access
version.

Both commands derive the caller from the verified session and selected active
tenant. They require the corresponding exact current structural capability; an
organisation account is neither required nor treated as a fallback. They use the
existing protected tenant-governance transaction and receipt pattern: an exact
accepted retry returns the recorded result, a changed-input duplicate conflicts,
and a refusal or rollback creates no accepted receipt.

Reparenting must continue to enforce #23's tenant, self-parent and cycle rules.
It must also safely refuse a foreign or missing target, a prohibited lifecycle
state identified by the existing structural rules, and a stale expected revision.
An active child beneath a suspended parent remains valid when #23 permits that
existing shape; this slice must not introduce a new parent-active requirement.

The proof must establish: authorised operation without target-organisation
membership; root moves and subtree preservation; exact capability separation;
foreign/missing/self/descendant refusal; replay and changed-payload conflict;
no mutation or receipt on refusal; and two concurrency cases. First, competing
moves cannot create a cycle. Second, an authority that was effective while queued
on the tenant lock but expires before it obtains the lock must be refused without
changing structure or creating a receipt. Reuse the deterministic database-clock
approach from Slice 3A rather than adding a timer or a second authority model.

Do not add a generic command dispatcher, a hierarchy representation, a policy
engine, a counter, a history table or another receipt mechanism. The existing
parent links, governance locks, capability catalogue and accepted receipts are
the complete implementation basis.

## Slice 3C — protected organisation lifecycle

This slice has exactly three commands: suspend an `active` organisation,
reactivate a `suspended` organisation, and administratively archive an `active`
or `suspended` organisation. Every command uses the exact current
`platform.tenant.organizations.lifecycle` capability, verified session identity,
active selected tenant, target expected revision and existing accepted receipt.
No target-organisation account is required or granted.

A successful new transition changes only organisation state, state-change time
and the existing revision, increments that revision once and commits one accepted
receipt atomically. Exact replay first rechecks current tenant authority and then
returns its original accepted result before current target-state or revision
checks. A changed-input duplicate conflicts. Same-state commands,
archived/removal-pending source states, stale or exhausted revisions and failed
transactions leave no state change or accepted receipt.

Suspension affects only the named organisation. An independently active child
remains active and enterable under its own valid tenant/account context. Archive
is terminal in this task and refuses while the named organisation has an active
or suspended direct child. It does not automatically archive, move or change
descendants. None of these operations changes identity, names, parent links,
accounts, roles, settings, installations, records, retention state, provider
identity or Access version.

Reactivation requires an existing `organization_stewardship_requirements` fact
and the delivered current `organization_has_permanent_steward` predicate under
the target organisation's governance lock at fresh database time. Calling the
assert helper alone is insufficient because its defined no-requirement outcome
does not refuse. A qualifying replacement steward is valid; the operation must
not recreate stewardship adoption or historical grants.

Reactivation remains valid under a suspended parent. An archived or
removal-pending parent refuses under #23's structural rules. Reuse a stored
management-application requirement when it exists; do not manufacture one for a
current requirement that has no binding.

Acquire the target organisation's existing governance row **for update** before
the tenant and Identity locks, then recheck authority (including an active
cluster-local identity projection) and readiness after waits. This preserves
the compatible ordering with request resolution; do not append an Access lock to
the tenant-first Slice 3B sequence. Tenant serialization covers the child-state
check and lifecycle write. No generic lifecycle framework, counter, history,
retry system or new stewardship evaluator is permitted.

Prove valid transitions without local membership; exact capability separation;
safe foreign/missing and temporal-authority refusals; expected revision, replay,
changed-payload conflict and rollback; non-cascading suspension; archive refusal
for active and suspended children; reactivation refusal for missing/nonqualifying
stewardship and success for a qualifying replacement steward. Separate-session
proof covers archive versus child attachment/reactivation, competing transitions,
authority expiry while queued, reactivation versus a supported stewardship/account
mutation, and lifecycle versus request resolution. The result must show no invalid
state, leaked receipt or lock-order deadlock.

## Slice 3D — tenant-authorised organisation creation

This slice has one server-only, channel-neutral command:
`create_tenant_organization`. It creates exactly one active organisation inside
the caller's selected tenant. Its input is an explicit duplicate key, tenant ID,
nullable parent ID (explicit `null` means a root), permanent short name, display
name, nominated organisation-steward identity, that steward account's display
name/language/time zone, and the five explicit runtime settings owned by
[#430](https://github.com/Abzum-NZ/Abzum-Vortex/issues/430): language, time zone,
currency, date format and number format. Server/database facts supply IDs, actor,
correlation, time and initial revisions. Creation has no expected prior revision.

The verified caller must have an active local identity projection, active selected
tenant and the exact current `platform.tenant.organizations.create` capability.
Tenant `.manage`, organisation membership and every other capability refuse; no
target organisation account is required. The nominated steward is an explicitly
nominated verified identity with an existing active local projection. This human
command neither creates nor revives a projection, performs provider/email lookup,
or grants the creator anything by default. The creator obtains an account, role or
stewardship only when explicitly nominated.

On first application, the transaction creates the active organisation, the
nominated steward's active organisation account, #430 runtime settings, its
private Access baseline and platform catalogue, and invokes the delivered
[#33 stewardship adoption](../evidence/issue-33-stewardship/README.md). It does
not create a tenant, tenant-administrator assignment, invitation, IAM installation
or binding, parent membership, inherited business access, second stewardship
evaluator, or new system-operator wrapper. All failures roll back the entire set.

The parent is either `null` or an existing same-tenant organisation. An active or
suspended parent is valid; a missing, foreign, archived or removal-pending parent
refuses. Creation changes no parent revision, lifecycle, settings, descendants or
Access version. It preserves #23's immutable scope, tenant-local short-name
uniqueness and hierarchy constraints without imposing a single-root policy.

Acquire tenant serialization, then compatible sorted identity-projection and
caller-assignment locks. Check authority at fresh database time after waits. An
exact accepted receipt is checked before current parent, nominee or created-scope
state; its exact retry returns the original identifiers, revisions and time, while
a changed payload conflicts. On a first application, lock and recheck parent and
nominee eligibility, create the transaction-private organisation governance
baseline, apply the owned settings and stewardship compositions, and write the
receipt atomically. Recheck temporal authority after any further blocking
acquisition. Existing organisation governance follows governance-before-tenant;
this new private governance row needs no existing-row lock inversion. Tenant
serialization protects creation versus parent archive.

Proof must cover root and child creation, explicit self/different nominee, and no
creator membership for a different nominee; exact capability and tenant/projection/
nominee/temporal refusals; settings and minimum stewardship facts; simultaneous
same-key creation producing exactly one complete organisation/account/settings/
stewardship set and one receipt; changed-input conflict; competing same-short-name
creation with no orphan facts;
creation versus parent archive, caller authority change/revoke/expiry, request
resolution and supported governance operations without a lock-order deadlock; and
exact replay after later account/stewardship mutation without restoring historical
grants. Do not add a generic dispatcher, retry framework, history, counter,
policy engine, UI, MCP transport or AI behaviour.

## Slice 4A — configured-system projection lifecycle

This slice has three server-only configured-system commands:
`suspend_cluster_identity` (`active` to `suspended`),
`reactivate_cluster_identity` (`suspended` to `active`), and
`close_cluster_identity` (`active` or `suspended` to terminal `closed`). Each
strict input has a duplicate key, target identity and expected projection
revision. The existing validated configured-system boundary supplies the cluster
and non-nil system actor; a supplied caller, selected tenant, human assignment or
organisation permission never substitutes.

Each first accepted command changes only the named existing projection's state,
revision and existing audit actor/time/correlation facts, then writes one accepted
receipt atomically. It creates no projection, account, assignment or stewardship
adoption, and changes no organisation Access version. Exact replay returns its
original result before current target state/revision checks; a changed fingerprint
conflicts. Same-state, terminal, missing, stale or exhausted-revision commands
refuse without an accepted receipt. Audit time retains the greatest locked audit
time where the existing trigger requires it; fresh database time remains the only
temporal-authority time.

Before changing a projection, discover organisations containing its accounts and
tenants containing those organisations or its tenant-administrator assignments.
History identifies affected scope only; expired or revoked assignments never
qualify. Lock existing organisation governance rows `FOR UPDATE` ordered by
organisation ID, then tenant rows `FOR UPDATE` ordered by tenant ID, then the
target projection `FOR UPDATE`. Re-read the
scope after locking. If creation, invitation acceptance or tenant assignment added
an affected scope, refuse stale and roll back; do not append locks or introduce a
retry loop. Evaluate stewardship against the proposed post-transition projection
state in the same transaction, rather than counting the still-active target. Reuse the delivered tenant-manager predicate and organisation
stewardship owner for current qualifying facts, including suspended adopted scopes
and a stored management-application requirement. An unrelated legacy scope with
no stewardship requirement does not require new adoption.

Proof must cover all valid/terminal transitions; malformed/unconfigured operator,
missing target, injected authority, stale/exhausted revision and receipt cases;
multi-organisation/multi-tenant rollback when any affected scope loses its final
required steward; qualifying replacements; scheduled, expired and revoked
or time-limited replacement managers; no revival of revoked/expired grants; unchanged accounts,
assignments, roles, organisation lifecycle and Access versions; and separate
sessions for competing transitions, replacement mutations, mutually dependent
identities, Slice 3D creation, invitation acceptance, tenant assignment, request
resolution and organisation lifecycle. A forced discovery race must serialize or
refuse stale, never succeed with an unguarded new scope. No provider/Auth/session
mutation, other-cluster operation, tenant lifecycle, account offboarding, generic
lifecycle framework, UI, MCP transport or AI behaviour belongs here.

## Slice 4B — configured-system tenant lifecycle

This slice has two server-only configured-system commands: `suspend_tenant`
(`active` to `suspended`) and `reactivate_tenant` (`suspended` to `active`).
Each strict input has a duplicate key, tenant ID and expected tenant revision.
The existing validated configured-system boundary supplies cluster and non-nil
system actor; a human tenant capability, organisation role, browser actor or
selected context never substitutes.

A first accepted command changes only the tenant's state, state-change time and
revision, then writes one accepted receipt atomically. Child organisation state,
accounts, projections, assignments, roles, settings and Access versions do not
change. Exact replay returns the recorded result before current target state,
revision or readiness checks; a changed payload conflicts. Missing, same-state,
archived/removal-pending, stale or exhausted-revision commands refuse without a
receipt. Fresh database time is used for readiness; an audit-time clamp, if the
existing trigger needs one, affects only the persisted audit value.

Preserve the configured actor + cluster + operation + duplicate-key receipt
serialization. Discover the target tenant's organisations, lock their existing
governance rows `FOR UPDATE` in organisation-ID order, then lock the tenant
`FOR UPDATE`, and re-read the organisation set. If the organisation set changed,
refuse stale and roll back; do not add locks or retry automatically. After locks,
use fresh database time. When existing provisioning/adoption receipts establish
tenant stewardship, reuse the delivered permanent-manager predicate. Independently,
enforce the delivered permanent-steward predicate for every organisation carrying
an existing stewardship requirement, including suspended adopted organisations and
any stored management-application requirement. A qualifying current replacement
is valid; scheduled, expired, revoked, time-limited or inactive replacements do
not qualify. Do not manufacture adoption, require an historical steward or
restore grants: adoption currently accepts only active tenants, so a new adoption
gate would trap an otherwise recoverable suspended legacy tenant.

Proof must cover both transitions, unchanged child scopes and unrelated tenants,
next-request tenant entry refusal/restoration through existing context rules,
strict/refusal/revision/receipt/rollback cases, current readiness and legacy
no-adoption behaviour, future audit timestamp with a scheduled manager, and
separate sessions for same-key replay, competing transitions, organisation
creation/discovery, manager change/revoke, Slice 4A projection lifecycle, a
representative stewardship/account mutation and request resolution. Every outcome
must serialize or refuse stale without a partial write or deadlock. No projection,
provider/Auth/session, other-cluster, tenant archive/removal, account offboarding,
child transition, automatic grant repair, generic lifecycle framework, UI, MCP
transport or AI behaviour belongs here.

## Slice 5 — delivered organisation-local administrative reads

This slice provides five server-only operations through the existing resolved
organisation request: `listOrganizationAccounts`, `readOrganizationAccount`,
`listOrganizationInvitations`, `readOrganizationInvitation`, and
`readOrganizationRuntimeSettings`. The list inputs accept only page size from 1
to 100 and an optional non-nil account or invitation ID used only as an ordering
cursor. Detail inputs accept exactly one
non-nil organisation-local ID. Callers never provide a tenant, selected account,
Access version, authority declaration, clock, or correlation.

Each operation resolves the active account, organisation and tenant through
[#27](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27), then makes one fixed
[#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) decision in the same
transaction: `platform.organization.accounts.read` for account operations,
`platform.organization.invitations.read` for invitation operations, or
`platform.organization.runtime_settings.read` for settings. Membership, a tenant
assignment, a different `.read` permission, or a `.manage` permission never
substitutes. No extra approval or MFA condition is introduced.

Identity owns private, scope-filtered projections; Access owns the fixed protected
database wrappers that invoke them only after allowance. Account summaries expose
only local account ID, optional local display name, stored account state, optional
language/time-zone preferences, and positive revision. They include active,
suspended and closed accounts, but never global identity IDs, provider profiles,
email, other memberships, roles, permissions, invitation provenance or audit
evidence. Invitation reads reuse the established safe invitation contract; they
include its local administrative recipient, lifecycle facts and revision, but no
secret, fingerprint, private access intent or provider profile. Settings reads call
[#430](https://github.com/Abzum-NZ/Abzum-Vortex/issues/430)'s existing internal
reader for the resolved organisation and return its result or explicit absence;
this slice does not recreate settings validation, storage, updates, or runtime
semantics.

Lists sort by permanent local ID ascending, filter their scope and cursor in SQL,
and use `LIMIT pageSize + 1`. They return at most the requested size and a next
cursor only when another row exists. Foreign and missing detail IDs both receive
the existing unavailable result; a foreign cursor is only an ordering value and
reveals nothing. There is no total count, offset, search, filter, configurable
sort, unbounded fetch, cross-page snapshot, receipt, Activity write, Access
increment, target lock, automatic retry, generic read engine, or public table
access.

Reads retain the established organisation-governance-before-Identity resolver
order, use fresh database time after resolver waits, and perform their bounded
projection in that transaction. A concurrent governance change must result in the
current refusal or current allowed result, never protected rows based on stale
authority. A settings read may see the previous or next whole revision, never a
mixed value. The proof covers strict contracts, restricted request-role SQL paths,
all account and invitation lifecycle variants, pagination and scope isolation,
missing settings, no mutation side effects, no direct table/helper access, and
representative read-versus-governance and read-versus-settings concurrency.

Account or invitation mutation, offboarding, ownership transfer, Groups, PIM,
general query/filter engines, UI, application definitions, MCP/AI, provider
operations and Production deployment remain outside this slice.

## Slice 6 — organisation-local account lifecycle and invitations

This slice adds five
server-only commands: `suspendOrganizationAccount`,
`reactivateOrganizationAccount`, `closeOrganizationAccount`,
`createOrganizationInvitation`, and `revokeOrganizationInvitation`. Account
changes accept one local account ID, positive expected revision and duplicate
key. Invitation creation accepts a trimmed/lower-cased valid email, a future
expiry and duplicate key; revocation accepts one local invitation ID, positive
expected revision and duplicate key. All identifiers and duplicate keys are
non-nil UUIDs. Unknown fields refuse. A caller never supplies actor, tenant,
resolved organisation/account, authority, permission, Access version, clock,
correlation, role/Group intent, secret or fingerprint.

The commands reuse `createHumanOrganizationRequestService.runChange` and its
delivered governance-first resolver; no task-specific resolver or second
permission evaluator is introduced. Account commands require only
`platform.organization.accounts.manage`; invitation commands require only
`platform.organization.invitations.manage`. The exact decision occurs inside
the same transaction. A `.read` permission, the other `.manage` permission,
membership, tenant administration, a role name, or configured-system authority
never substitutes. No new MFA, approval, or IAM workflow is introduced for
these account-only, no-intent operations.

The protected Access wrappers call the existing owners rather than duplicate
their rules: account transitions use the guarded account-state writer, which
owns same-transaction Access invalidation and the permanent-steward assertion;
invitations use [#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24)'s
no-intent create/revoke writers. A successful account transition is respectively
`active → suspended`, `suspended/closed → active`, or `active/suspended →
closed`. Closing is not deletion or offboarding: the same local account can be
reactivated under the existing contract. Existing qualifying authority can then
be effective again; revoked or expired authority does not revive. Invitation
revoke accepts unaccepted, unrevoked invitations, including expired invitations;
accepted or already-revoked invitations refuse. These commands neither create
accounts, roles, assignments or intents nor change provider/session state.

The current organisation account, tenant, fixed operation and duplicate key use
the existing receipt model. Its canonical input fingerprint includes the
resolved organisation and command, and its stored subjects include the
organisation and target. Current request eligibility and the exact permission
are checked before a receipt may replay. An exact accepted retry returns recorded
minimal evidence before checking the target's current state or expected revision;
later target changes do not alter that recorded result. Changed input conflicts;
a now-ineligible caller cannot use a replay to regain entry. Account outcomes include operation, organisation, target,
target revision, receipt/correlation ID, accepted server time and recorded Access
version. Invitation outcomes contain equivalent non-secret evidence. Raw
invitation secret material exists only in the first committed creation response,
after commit; it is never retained in a receipt, replay, error, log or Activity
record. A lost first response cannot recover a secret: an authorised
administrator revokes and creates a fresh invitation instead.

Use fresh database time after resolver waits. Reuse existing target locks,
stewardship checks and lock order; do not add a retry layer, generic mutation
framework, new history/counter/policy evaluator or dispatcher. Missing and
foreign targets share safe unavailable behaviour. Same-state, prohibited,
stale or exhausted-revision transitions refuse without accepted receipt or
mutation. An accepted account command changes its target, increments Access
exactly once and writes its receipt together or changes none. Invitation
creation/revocation does not increment Access and rolls back both writer and
receipt together on failure. Receipt replay increments nothing.

Proof must execute the exact request-role boundary, including each precise
permission, cross-permission/member/tenant-only refusal, direct-table/helper ACL
denial, closed-account reactivation, invitation pending/expired/accepted/revoked
states, strict input/results, no secret on replay/error, permanent-steward
protection, receipt rollback and replay scope. Use representative real races for
same-key duplicates, changed-input duplicates, competing account revisions,
remaining-steward transitions, invitation acceptance versus revoke, inactive
account versus invitation acceptance, authority change while queued, and overlap
with request reads/projection/tenant lifecycle. Do not create an exhaustive
cross-product of equivalent races.

Profile/preferences editing, direct account creation, invitation acceptance
redesign, invitation intents, role/Group/PIM/delegation changes, workflow
approvals, email delivery, UI/routes, MCP/AI, runtime-settings mutation,
provider/session changes, record ownership transfer, deletion/retention and
Production deployment remain outside Slice 6.

### 7. Integrated evidence and delivery

Run focused contract/storage/ACL proofs first, then actual transaction and race
proofs, full repository and Local database gates, and exact protected Testing
delivery. Production remains separately gated.

## Acceptance checklist

- [x] No implementation begins before the exact hosted completion of
      [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34).
- [ ] The configured operator idempotently provisions or adopts live scopes with
      explicit tenant and organisation steward nominations; no first-user,
      creator-order or browser owner path exists.
- [ ] The same person may receive both nominations only through two explicit,
      separately scoped choices and facts.
- [ ] [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) calls the delivered
      D1 stewardship and guarded account compositions; it does not recreate their
      role, assignment, delegation, final-steward or Access-version logic.
- [ ] Tenant authority resolves only current effective same-tenant structural
      assignments and cannot authorize organisation, application or record access.
- [ ] Organisation-local work requires the active
      [#27](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27) context and exact
      [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) permission. Changing
      work follows governance-first lock order and contains no second role/permission
      evaluator.
- [ ] Tenant assignment, organisation hierarchy, projection and account lifecycle
      races cannot remove the final required permanent tenant or organisation
      steward.
- [ ] Organisation creation never grants its creating tenant administrator local
      membership or a role unless that person is explicitly nominated.
- [ ] Parent lifecycle does not cascade to active children; tenant suspension blocks
      the tenant without rewriting child state.
- [ ] Invitation creation/revocation preserves
      [#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24) invariants and exact
      replay never returns the raw secret. This task creates no invitation access
      intent.
- [ ] Provisioning initializes explicit runtime settings through #430's
      Identity-owned initializer in its existing outer transaction. Administrative
      settings reads use the exact `.read` permission and #430 reader; #30 does
      not own settings validation, storage, updates or retry semantics.
- [ ] Receipts provide deterministic same-input replay and changed-input conflict
      without storing secrets, profiles, business values or duplicate authority.
- [ ] Safe reads are bounded, deterministic and scope-filtered and expose no foreign
      tenant existence, credentials, provider profile, permission internals or SQL.
- [ ] User-facing tenant-assignment and organisation-access grant journeys remain
      with [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267); the
      [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) service proof does
      not claim a usable IAM application.
- [ ] Independent review checks the actual completed work against this whole task;
      repository, Local database, real concurrency, schema lint/advisers, source
      boundary and protected Testing gates pass for the exact revision.
- [ ] Shipping code contains no example application, business domain, hardcoded
      business role, UI, MCP, model, assistant, prompt, sampling or AI behaviour.

## Explicitly outside this task

- Administration pages, routes and application definitions; these belong to
  [#72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72) and
  [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267).
- Role, Group, membership, assignment, activation, delegation or invitation-intent
  management; these belong to [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).
- Application publication, registration, installation and update journeys; these
  belong to [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64).
- Record/field/share/data-policy decisions beyond the central decision; these remain
  with [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35),
  [#36](https://github.com/Abzum-NZ/Abzum-Vortex/issues/36),
  [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37),
  [#38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38),
  [#39](https://github.com/Abzum-NZ/Abzum-Vortex/issues/39),
  [#153](https://github.com/Abzum-NZ/Abzum-Vortex/issues/153) and
  [#154](https://github.com/Abzum-NZ/Abzum-Vortex/issues/154).
- Business administration records, tenant self-service, email delivery, domain
  ownership, implicit default roles and identity lookup by email.
- Full encrypted archive/restore, `removal_pending`, deletion and retention/hold
  policy; [#255](https://github.com/Abzum-NZ/Abzum-Vortex/issues/255) and later
  operated work own those concerns.
- Environment-wide provider/Auth disablement, cross-cluster identity changes and
  immediate token-revocation claims; these belong to
  [#171](https://github.com/Abzum-NZ/Abzum-Vortex/issues/171).
- Generic Activity/refusal delivery beyond the existing lifecycle audit facts and
  accepted receipts. [#252](https://github.com/Abzum-NZ/Abzum-Vortex/issues/252)
  is already complete and does not need to be reopened for this slice.
