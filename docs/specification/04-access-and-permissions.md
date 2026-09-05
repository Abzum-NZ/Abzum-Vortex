# 4. Access and permissions

[Previous: Platform composition and publication](03-composition-and-publication.md) · [Specification index](README.md) · Next: [Modules, fields and relationships](05-modules-fields-and-relationships.md)

## One access decision

The current model is [Roles, Groups and privileged role activation](appendices/groups-and-privileged-access.md). Groups collect organisation accounts; roles define permissions. Eligibility for a PIM-protected role grants no use until that account completes its required activation. The same central decision enforces both ordinary and privileged access.

Every protected operation asks one question: **May this person perform this action on this thing in this organisation?**

```mermaid
flowchart LR
    REQ[Request] --> ID[Confirm identity, session and organisation account]
    ID --> PERM[Check organisation and application permissions]
    PERM --> SCOPE[Check record visibility, ownership and sharing]
    SCOPE --> FIELD[Check field and action restrictions]
    FIELD --> RESULT{Allowed?}
    RESULT -- Yes --> RUN[Perform operation]
    RESULT -- No --> DENY[Refuse and record reason]
```

The decision receives:

- The global identity and active organisation account from [people, organisations and sign-in](02-people-organisations-and-sign-in.md).
- The requested action.
- The target definition, record, field, file, workflow, connection, or administration function.
- The current [application](07-applications-pages-and-themes.md), when the operation occurs inside an application.
- Record ownership, group, explicit sharing, and lifecycle state when a [record](06-records-and-lifecycle.md) is involved.

The result is either **allowed** or **refused**, with a stable reason code suitable for [activity history](14-activity-privacy-and-retention.md). An error, missing value, unknown permission, or unavailable access service produces **refused**.

## Where access is enforced

The same decision is enforced through coordinated database and server boundaries:

1. A database decision function is the final protection for organisation-owned database rows.
2. A server access library calls the database decision for row operations and applies the same permission vocabulary to files, caches, search, workflows, connections, programmable interfaces, and the governed MCP surface.

The database function, permission vocabulary, and shared test cases are canonical. The system does not claim that one TypeScript function runs inside PostgreSQL. Parity is proved by the [access test suite](20-quality-and-acceptance.md#organisation-separation-suite).

The server consumes the already validated, transaction-bound [organisation request context](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27); it does not select a different identity or account. The operation's trusted declaration binds its action, target and exact required permission. Possessing an unrelated valid permission cannot authorise the requested action. Client-supplied operation parameters are validated candidates, not a policy declaration or an allow decision.

The database evaluates stored role, assignment and delegation facts once. The server calls that decision and composes the required target restrictions; it does not independently reimplement role evaluation in TypeScript. Browser, server and [MCP](12-connections-and-interfaces.md#governed-mcp-access) operations reach the same boundary. A credential's application or capability restrictions can only narrow current account authority. High-impact operations also require their declared verified authentication strength and recent-authentication evidence.

[Identity evidence #276](https://github.com/Abzum-NZ/Abzum-Vortex/issues/276) supplies the verified authentication method and time through the existing session/context boundary. Token issue time, token refresh and request-context creation time do not prove recent sign-in or recent MFA. If genuine evidence satisfying the operation's declared strength and maximum age is absent, that protected action is refused; an otherwise valid ordinary session remains usable for operations without that requirement. Access never parses provider claims itself. This does not impose MFA on every operation: recent sign-in and specifically required recent MFA remain distinct requirements.

An allow result is evidence for one operation and verified state, not a reusable permission token. Its private evidence binds the current Access version and an expiry/recheck bound no later than the earliest relevant session, context, account, membership, assignment, delegation or sharing transition. An unchanged Access version cannot keep an expired grant alive. The operation rechecks when that bound is reached. Concurrent changes must yield a decision from wholly old or wholly new valid facts, never a mixture of role, registration and assignment revisions.

Every operation declares which lifecycle, row, field, sharing or public restrictions it needs. Missing or unavailable required policy refuses the final operation; a basic role match is not final authority over a record. [Central Access #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) establishes that closed composition boundary, while [row rules #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35), [scopes #36](https://github.com/Abzum-NZ/Abzum-Vortex/issues/36), [fields #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) and the later sharing/interface tasks supply their actual policies. It adds no second operation registry, access-state store or activity writer. Internal evidence is not returned as role labels, permission keys or private record values in a user-facing refusal.

## Roles

### IAM is the access-management application

All user-facing role grants and access-expanding changes use the [IAM Vortex application](appendices/iam-application.md), including its user-linked request, review and assignment views and generic approval workflows. Organisation ownership remains unchanged. IAM calls the protected Access operations; editing an ordinary request or approval record cannot grant access. Other administration applications link to IAM instead of offering parallel role-grant forms. Its guided first-steward setup and immediate removal paths are defined in the same application contract.

### One organisation-managed catalogue

All organisation roles, application-role registrations, permission availability, Groups and assignments are managed within one organisation. An application declares its permissions and reusable role templates; it does not operate an independent user or permission administration system. Organisation administrators manage both organisation-wide and application-specific access through the same [administration operations](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).

An organisation account, not the global identity, receives a direct assignment. Roles, Groups and assignments from another organisation or a parent organisation are never inherited implicitly. Tenant structure administration remains a separate authority and grants no organisation-management or application-data permission.

```mermaid
flowchart TD
    DEF[Published application permissions and role templates] --> REG[Register in the selected organisation]
    REG --> CAT[One organisation permission and role catalogue]
    ADMIN[Authorised organisation administrator] --> CAT
    CAT --> ROLE[Organisation-wide or application-specific roles]
    ROLE --> ASSIGN[Explicit assignments to organisation accounts or Groups]
    ASSIGN --> CHECK[One access decision for the exact target]
    CHECK --> RESULT[Allowed pages, actions, records and fields]
```

### Application registration and changes

When an application is registered for use in an organisation, its exact published permission declarations and supplied role templates become available in that organisation's catalogue. Registration validates the application and bound-module ownership and version evidence through [the permission registry](https://github.com/Abzum-NZ/Abzum-Vortex/issues/32). It creates no user assignment and does not make the application available to every member.

A supplied role template stays part of its immutable application release. Its organisation-local registration records the exact application root, release and catalogue fingerprint; assignments are live organisation data. An administrator may create a separate organisation-owned role from a template and adjust its exact permissions without rewriting the published template. Such a custom role may cover selected permissions across several registered applications, but each permission retains its exact owning application or module scope. A shared display name such as “Manager” never joins two roles or their authority.

Published wildcard expansion and live assignable authority are separate evidence. Preserve the exact immutable source template and its fully resolved source permissions. The live wildcard projection excludes administrative permissions and explicit export actions and contains only permissions owned by that application; it never draws authority from bound modules. A module using the same key cannot make an application-only wildcard ambiguous, while an exact-key template still refuses ambiguous ownership. Exact selection may explicitly request export, subject to the administrator's separate current delegation and acceptance checks. An all-excluded wildcard can be represented as a prepared template with no live permissions, but cannot become an active assignable role. [#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) uses one shared projection rule; it does not rewrite published V1 bytes or infer security meaning from permission labels or key text.

Permission resolution uses the organisation and permanent owning definition and permission identities, not a display label or a bare key alone. This distinguishes independent applications with identical display names or authored permission keys; it does not relax Definition's rules for unique local application keys. Application access, record visibility and field restrictions remain separate requirements even when one organisation role contains permissions for several applications.

Publishing a new application release changes no live registration or assignment. Only an explicitly authorised registration upgrade or withdrawal changes the active organisation release and permission availability. That change and its Access-version invalidation commit together through the owning application operation.

Registration makes templates available but creates no assignable local role or assignment. Accepting a template as a local role is a separate explicit catalogue operation; assigning that role is another protected grant. Withdrawal checks the exact current registration and expected revision inside the protected transaction. It does not need to reload the published definition or reconstruct a template being removed, so a Definition-read outage cannot prevent authorised withdrawal. Registering, upgrading or reactivating still requires verified exact release evidence.

An activated application update cannot silently broaden an assigned role. Added permissions, changed permission meaning and changed role grants require explicit authorised review before existing assignments can use the expanded access. An organisation-owned custom role is not overwritten by an application update. Removed permissions and unavailable applications cannot remain usable through old role registrations or cached answers. Historical assignment and release evidence is retained without retaining authority.

Bound-module permission availability records its active supplying registrations and exact module release evidence. Withdrawing one application does not remove a module permission still supplied by another active compatible registration in that organisation; withdrawing the last supplying registration makes it unavailable. This catalogue availability never supplies application-entry or record visibility by itself. In particular, an application-contained record scope remains bound to its own application even when another application supplies the same module permission.

A withdrawn registration may be explicitly reactivated using its current revision and a validated target release. Reactivation creates new registration evidence; it is not an automatic retry or a resurrection of old grants. Existing use assignments and bounded delegation require fresh authorised acceptance before becoming effective again. The [application operation #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) coordinates that acceptance through [Access administration #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).

The same protection applies when an otherwise active application removes a permission and later restores it, changes its meaning and later changes it back, or removes and restores a supplied role template. An unchanged name or permanent identifier does not restore the old authority. [Role storage #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) records whether each exact permission has remained continuously available with the same meaning in its application context. A break requires new acceptance; display-only changes do not. Another application's use of the same module cannot repair that break for this application.

Fresh acceptance approves one exact role permission set for an explicitly listed set of existing account or Group assignments. The request binds their identifiers and current revisions; a changed, missing or additional assignment requires a refreshed request. [IAM](appendices/iam-application.md) presents those affected assignments, while [the protected operation](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) rechecks the administrator's current authority before committing. Assignments reference the accepted role rather than storing duplicate permission lists. Revoked assignments are not restored, and a later assignment is a separately authorised grant. Bounded authority to grant permissions requires its own explicit acceptance and never follows a use-role approval automatically.

```mermaid
flowchart LR
    A[Permission accepted for a role] --> B[Permission removed or meaning changed]
    B --> C[Old access no longer effective]
    C --> D[Permission becomes available again]
    D --> E[Access remains ineffective]
    E --> F[Authorised review of exact role and affected assignments]
    F --> G[New accepted role revision]
```

Application updates reduce an accepted application-role permission set when permissions or template entries disappear; returning entries count as additions requiring acceptance. Organisation-owned custom roles are not rewritten by those updates, but their old permission references remain ineffective after an availability break until explicitly refreshed. Historical evidence is retained in both cases.

An application role awaiting acceptance of changes (`acceptance_required`) preserves only its continuously valid, previously accepted permissions for existing non-revoked assignments. Pending additions grant nothing. Each stored permission still passes the current availability, continuity and meaning checks in [the central decision](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34). Only an `active` role may receive a new assignment; `unavailable` and `retired` roles grant nothing. Explicit acceptance returns the role to `active` only after checking the exact candidate, complete affected-assignment list and current delegated authority. Adding a permission must not, by itself, remove existing valid permissions while review is pending.

A currently active supplied role can stay active after an update that only removes permissions, provided at least one accepted permission remains and there are no added or restored permissions awaiting acceptance. An empty role cannot stay active. A role already awaiting acceptance never returns to active just because a later application update removes its pending additions. A missing template or withdrawn application makes the role unavailable; bringing it back requires acceptance. Retired roles stay retired. These automatic changes preserve the original acceptance evidence and the role's existing privileged classification and activation policy; they are not new approvals or activations.

The same retained-access rule applies to already activated privileged roles. A separate [role-authority continuity number](appendices/groups-and-privileged-access.md#retained-permissions-during-role-review) preserves still-valid activation use across metadata changes, narrowing and pending additions. Accepting added or restored authority starts a new period and requires fresh activation, without silently revoking the underlying eligibility assignment. Existing eligibility may activate only the retained accepted remainder during review; pending additions grant nothing. A pending activation request still becomes stale if its exact proposed role revision changes.

The [coordinated application-access change](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) applies registration, permission/template availability and supplied-role reductions together. Either all changes become visible, with one Access-version change, or none do. An update that already exactly matches the current registration and derived role state returns unchanged without creating history. A request based on an older registration revision is refused rather than applied again. A matching application fingerprint alone is not enough: the related permission, template and role state must also be consistent. See the [closed change contracts](appendices/data-contracts.md#permission-and-role-contracts).

```mermaid
flowchart LR
    U[Authorised application update] --> T
    subgraph T[One all-or-nothing change]
        C[Update registration and permission/template availability] --> R[Keep only continuously valid accepted role permissions]
        R --> V[Change the organisation Access version once]
    end
    T --> E[Existing assignments keep the accepted remainder]
    T --> P[New or restored permissions await explicit acceptance]
    P --> M[Check exact candidate and all affected assignments]
    M --> A[Activate accepted role revision]
    A --> N[New assignments may be granted separately]
```

### Organisation roles

An organisation role grants exact permissions within one organisation, such as managing members, definitions, connections, protected data handling, or selected actions in one or more applications. Its name or organisation-wide ownership never implies all applications or all records. Tenant structure and entitlement administration use separate tenant permissions and never arrive through an organisation role.

### Application roles

An application role grants permissions inside one [application](07-applications-pages-and-themes.md), such as discovering the application, opening particular pages, performing named actions, or reading a record scope. It is registered and assigned within that application's organisation through the same organisation-managed catalogue described above.

When accepting a supplied template as an assignable local role, the administrator supplies its organisation-local description alongside its local key and label. The current published template has no description field; Vortex neither invents one nor changes the published source contract to create local administrative metadata.

### Assignment

An organisation account may have several organisation roles and several application roles. The effective permission set is the union of active role grants, followed by field restrictions and record-scope restrictions. There is no hidden default administrator permission.

### Managing access is different from using data

An administrator needs the exact role-management permission and an explicit scope of permissions they may assign. That delegation authority does not itself permit opening an application or reading its records. This lets an organisation steward assign the first application role without first receiving the application's business-data access.

The scope is either deliberately organisation-wide catalogue management or a fixed set of exact, accepted permission references and application contexts. Organisation-wide governance explicitly includes permissions registered by future applications in that same organisation, but does not assign their use to anyone. An application-scoped manager receives only the reviewed scope for that application; new permissions or changed meanings do not silently enlarge it.

Every create, edit, assignment, template-upgrade approval or delegation change checks all affected before-and-after permission scopes through central Access. Application context is part of that check even for a permission supplied by a module shared with another application. Managing access in one application cannot become authority over another merely because both bind the same module. A person cannot delegate wider management authority than they hold, whether directly or through another account or Group. This also prevents two managers granting wider powers to each other and then receiving them back.

The delegation representation is a closed scope and subset check, not a user-authored policy language. Published role templates cannot create organisation-wide delegation authority. [Role persistence #33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33) stores the facts, [central Access #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34) evaluates them and [access administration #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) invokes protected changes.

### Initial organisation stewardship

The trusted [organisation-provisioning operation #30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) explicitly nominates the initial organisation steward and atomically establishes the active organisation account, minimum role/account-management permissions and direct, non-expiring organisation-wide delegation assignment. Those core permissions grant no application-data use. The complete [IAM setup](appendices/iam-application.md#setup-and-removal) separately and explicitly accepts only the exact application operating role needed to enter IAM and manage access, never rights to unrelated applications. The first person to sign in, a role label, an application installer and tenant-administrator status are never inferred to be the steward. Tenant and organisation stewards may be the same person only when both appointments are explicit.

Every usable organisation retains at least one active organisation account with a current, direct, non-expiring assignment carrying those minimum stewardship powers. Once IAM is activated, the required management-application operating assignment and availability are also protected as specified in [IAM setup](appendices/iam-application.md#setup-and-removal). A Group assignment or expiring delegate does not fulfil that permanent safeguard. Account suspension, role edits, assignment changes and identity lifecycle changes must preserve it in one concurrency-safe transaction. Existing organisations must be explicitly adopted through the trusted provisioning boundary; a migration cannot guess an owner. Until adoption, protected administration is unavailable rather than silently selecting an account.

## Permission names

Permissions use permanent names, not display labels. A name identifies the area, resource, and action. Examples:

- `platform.organization.accounts.read`
- `platform.organization.accounts.manage`
- `module.example.record.read`
- `module.example.record.update`
- `application.example.open`
- `application.example.action.complete`

Unknown names are refused at publication and at runtime. An application role may use the single entry `*` to mean all non-administrative permissions declared by that exact published application version. It cannot be combined with another permission entry, cannot include permissions from a bound module, and cannot cover tenant or organisation administration, security, entitlements, protected data handling, export, or sharing administration. Module-scoped and trailing wildcards are not supported.

Publishing an application role resolves `*` against that application's permission catalogue and records the catalogue fingerprint and expanded permission identifiers. A permission added later is not silently granted; the role must be reviewed and published again.

The exact initial organisation-administration identities, keys and meanings are defined in the [platform permission catalogue](appendices/platform-permission-catalogue.md). Business permission declarations continue to come from their own modules and applications.

## Record visibility

Permission to perform an action and visibility of a particular record are separate checks.

A record scope may include:

- All records the role can access.
- Records owned by the person.
- Records owned by a named group to which the person belongs.
- Records explicitly shared with the organisation account or any of its groups.
- Records reachable through an approved relationship from another visible record.
- A saved, validated condition defined by the application.

The scope is translated into database conditions. Records outside it must not be fetched and then hidden afterward.

### Direct record sharing inside one organisation

An authorised person may share one record directly with one organisation account or one group in the same organisation. The share has explicit readable and changeable field allowlists, optional expiry, grantor, recipient, reason, state, and activity history. A changeable field must also be readable.

The grantor must hold `record.share`, must be able to read every shared field, and must be able to change every changeable field. A direct share cannot grant delete, restore, export, re-share, ownership, role administration, or any permission the grantor does not hold. Group membership is evaluated on every request. Revocation, expiry, suspension, or group removal takes effect on the next request. Directly shared records appear in ordinary lists and search only where the receiving account also has application access and the page supports that record type.

## Field access

A role can allow or refuse reading or changing named fields. A response omits unreadable fields; it does not return them with blank or masked values unless a specific masking policy is later added to the [decision register](appendices/decisions.md).

Fields marked `sensitive` in [modules, fields and relationships](05-modules-fields-and-relationships.md) require an explicit read grant and are never copied to general search.

## Shared-record access

Sharing is an additional restriction, never a replacement for ordinary access. A recipient must pass both its own organisation/application checks and a source-issued grant. Missing, invalid, expired, or undecided information refuses access.

```mermaid
flowchart TD
    REQ[Request in recipient organisation account] --> LOCAL[Check recipient account, application and roles]
    LOCAL --> ROUTE{Source cluster?}
    ROUTE -- This cluster --> ADAPTER[Use local shared-record adapter]
    ROUTE -- Another cluster --> SIGN[Sign a short-lived recipient assertion]
    SIGN --> REMOTE[Send bounded request to source federation endpoint]
    ADAPTER --> GRANT[Source Access service checks one complete active grant]
    REMOTE --> GRANT
    GRANT --> SOURCE[Check source organisation, record state and sharing policy]
    SOURCE --> FIELDS[Keep only fields allowed by that same grant]
    FIELDS --> DB[Source database row restriction permits the operation]
    DB --> RESULT[Return or save in the source organisation]
```

### Between applications in one organisation

For `organisation_shared` storage, each application must bind the module and grant its own roles the required permissions; a separate sharing grant is unnecessary. For `application_contained` storage, another application also needs an active inter-application grant. The recipient application must bind a compatible version of the module so it can validate and display the records.

An inter-application grant may provide collaborative access when the use case requires it. The grant names the readable fields, the smaller or equal set of changeable fields, and any published shareable actions. The recipient uses ordinary record components, but those components expose only the granted capabilities. The record remains owned and saved by its source application; collaboration does not create a recipient copy or permit ownership, deletion, restoration, permission administration, or re-sharing.

### Between organisations

A source organisation may grant limited access to a recipient organisation. The business checks and screens do not change when the organisations are in different clusters. The shared-record gateway chooses a local adapter inside one cluster or a signed request to the source cluster through the [Vortex Federation API](17-runtime-storage-and-caching.md#vortex-federation-between-clusters).

The request acts through the person's active organisation account in the recipient organisation. It never uses roles from another account held by the same global identity. For a cross-cluster request, the recipient cluster verifies that local account and signs a short-lived assertion of its identity, application, roles, and access version. The source accepts that assertion only from the registered recipient cluster and still makes the authoritative grant and record decision itself.

The access decision confirms all of the following:

1. The global identity, recipient organisation account, recipient organisation, and recipient application are active.
2. The recipient account can enter the one named recipient application and currently holds at least one of the recipient application roles named by the grant.
3. One active grant independently covers the source record, requested action, and requested fields.
4. The record still matches the grant's approved scope. A changing set uses only a version-pinned published saved sharing condition with approved parameter values; a grant never supplies an inline condition.
5. The source organisation, record lifecycle, retention, and legal-hold rules permit the operation.
6. For a cross-cluster request, the recipient cluster signature, intended source audience, issue and expiry times, one-use nonce, protocol version, content fingerprint, and approved recipient region are valid.

Two grants cannot be combined to manufacture permission: the scope from one grant cannot be joined to the action or fields of another. If several grants independently permit the same request, the request is allowed and the activity entry records the grant identifiers used.

### Shared actions, fields, and export

Cross-organisation grants use explicit readable-field, changeable-field, and allowed-action lists. They do not use broad levels such as `collaborative` or `full_edit`. A changeable field must also be readable, and an action must be published by the source definition as shareable before a grant may name it. Fields classified as `sensitive` are unavailable in the first release. Omitted fields are not returned as blank or masked values; they are absent.

Export is an independent boolean approval, defaults to refused, and is included in the exact proposal approved by both organisations. When allowed, the source produces only the grant's readable fields from records that still match the grant. Ownership changes, deletion, restoration, permission administration, and re-sharing are never implied by a field or action allowlist.

### Protected grant consent

An editable record or ordinary workflow cannot activate a cross-organisation grant. Every cross-organisation grant requires one authorised source consent and one authorised recipient consent for the same complete proposal fingerprint. The source side confirms the records, condition and parameters, actions, fields, export choice, recipient region, start, and expiry. The recipient side confirms the named application, roles, responsibility, region, start, and expiry.

Changing any fingerprinted value withdraws the earlier decisions and requires both sides to review the new proposal. The Access service owns the grant and activates it only after verifying both immutable consent decisions. An ordinary business approval record has no security effect on a grant.

A consent decision is not later rewritten as revoked. Ending access revokes the grant through a new authorised source action, preserving both original decisions and recording the revocation separately.

For a cross-cluster grant, each cluster stores its own protected consent evidence. The source grant is authoritative. The recipient stores only a routing and user-interface mirror plus the source's signed activation receipt. A missed receipt is repaired through [grant reconciliation](17-runtime-storage-and-caching.md#grant-activation-and-reconciliation), not by a distributed database transaction.

## Public access

Public access is not a role shortcut. A [public page or interface](12-connections-and-interfaces.md) has a narrowly published operation and explicit field list.

- A field is unavailable publicly unless its definition sets `public_display` to `allowed`.
- `public_display` defaults to `refused`.
- A sensitive field can never be public.
- Public create and update operations accept only explicitly listed fields and run validation, rules, rate limits, file checks, and abuse protection.
- Public operations do not reveal whether a private record exists unless the published operation requires that result.

Public create and update field lists are checked against the same `public_display` choice; an operation cannot make a field public by naming it alone.

## Access-change speed

Role, organisation-account, group, sharing, and public-policy changes increase an organisation access version. Every cached access answer includes that version. A request with an old version is recalculated.

The Access service stores exactly one positive, monotonically increasing counter per organisation. The counter begins at `1`, is not an Identity or organisation-account field, and can be read or incremented only through narrow server-side Access operations. An access-affecting change and its increment commit in one transaction; a refused, rolled-back, or duplicate change does not advance it. Concurrent changes use an atomic database increment so neither update is lost. The request-context boundary reads the live value after it has verified the selected active organisation account; it never accepts a browser-supplied version.

```mermaid
flowchart LR
    C[Authorised access-affecting command] --> T[One PostgreSQL transaction]
    T --> I[Owning service changes its state]
    I --> V[Access increments the organisation version]
    V --> K{Both succeeded?}
    K -- Yes --> M[Commit state and next version]
    K -- No --> R[Roll back both]
    Q[Next protected request] --> L[Read exact live version]
    L --> D{Matches request context?}
    D -- Yes --> P[Continue permission decision]
    D -- No --> X[Refuse or rebuild context]
```

The Access relation records the organisation, current version, change time, changing actor, correlation identifier and one closed change reason. Initialisation is owner-only and idempotent. The general increment cannot claim the initialisation reason. Trusted pre-context runtime receives only the exact tenant-and-organisation read and the invitation-acceptance composition; browser roles, the request role and Supabase `service_role` receive no table or generic increment access. Permission-checked administration later calls the owner-only account-lifecycle composition rather than an Identity-only mutation.

Access removal takes effect on the next request. Long-running work rechecks access before every protected side effect, and subscriptions close or re-authorise when their access version changes.

Standalone role creation, revision or retirement uses `role_catalogue_changed`; assigning or revoking a role uses `role_assignment_changed`. A coordinated application registration, update, reactivation or withdrawal uses `application_access_changed` exactly once, including its permission, template and existing-role changes. Refusal or exact replay does not increment. These are change reasons, not separate permission evaluators or activity stores.

The recipient interface must remove previously displayed shared values when that next check is refused. It may retain non-content routing and activity references, but it cannot keep a visible snapshot, stale search result, component cache, or offline copy after the grant ends. A completed, separately approved export is the only exception because a downloaded file cannot be recalled.

## Administration safeguards

- Organisation-account, invitation, role, Group and runtime-setting administration requires the exact organisation permission through the central Access decision as well as an active organisation context. Membership, application administration and tenant-administrator assignment are not substitutes. [Protected administration](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) must consume the shared role/permission foundation before exposing those operations; it must not introduce a temporary tenant-capability bypass.
- A person may assign only permissions within their explicit delegation scope, and may grant management authority only within their own effective management scope. Holding a permission for personal use alone does not grant permission to assign it to others.
- The last effective permanent tenant steward and the last effective permanent organisation steward cannot be removed, expired or stripped of the required powers by any actor until a replacement is active. The organisation invariant is defined above; tenant stewardship is separately scoped and grants no organisation-data access.
- High-impact changes require recent sign-in confirmation at the operation's declared authentication strength; specifically MFA-required operations need genuine recent MFA evidence under [the same Identity contract](https://github.com/Abzum-NZ/Abzum-Vortex/issues/276).
- Tenant-administrator, hierarchy, role, organisation-account, group, direct-share, public-access, connection-secret, export, retention, entitlement and grant-consent changes are written to [activity history](14-activity-privacy-and-retention.md).

## Acceptance examples

- A person who can open a list but lacks record visibility never receives the hidden rows from the database.
- A direct share to any one of an account's groups grants only the named fields, and removing the account from that group removes access on the next request.
- A tenant administrator without a local organisation account and local role cannot read that organisation's records.
- Removing a role makes previously cached permission answers unusable.
- A page hidden in navigation remains protected when its address is entered directly.
- A public page cannot display a field merely because the field is not classified as personal data.
- Database tests and end-to-end tests use the same access examples but are run at the layer each example actually tests.
- A read-only cross-organisation grant does not allow creating, changing, deleting, exporting, commenting on, or attaching files to records.
- A sensitive field is never included in cross-organisation query results even when the grant does not specify a field mask.
- Revoking a cross-organisation grant makes previously cached permission answers for that grant unusable.
- Revoking an inter-application grant removes the shared values from the recipient component on its next access check; navigating back or using a client cache cannot reveal them.
- A collaborative inter-application grant changes only its named fields and runs only its named shareable actions against the source record.
- A person with accounts in both organisations cannot use roles from the source account while acting through the recipient account.
- Directly changing an ordinary approval record cannot activate a sharing grant.
- A cross-organisation grant with only one side's consent remains inactive.
- Adding an action, field, role, application, condition parameter, region, or later expiry invalidates both earlier approvals.
- Assigning a named role to another active account deliberately adds that account to the approved audience; removing the role removes access on the next request.
- Moving either organisation to another cluster in an already approved region does not change the grant's business meaning; the gateway changes route after the protected directory and grant routing state are updated and verified. Moving the recipient to a different region suspends the grant until the source approves that destination.
- A forged, expired, replayed, version-incompatible, or incorrectly addressed cross-cluster request is refused before any source record is queried.

## Declarative actor-relative scopes

The saved conditions and relationship scopes above use the early typed scope and database-condition foundation in [#36](https://github.com/Abzum-NZ/Abzum-Vortex/issues/36), composed through [central Access #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34). The later [condition builder #57](https://github.com/Abzum-NZ/Abzum-Vortex/issues/57) reuses that foundation; Access does not wait for the later builder or treat an unavailable scope evaluator as permission to proceed. Current-account parameters are bound from verified server context; client-supplied identity is never authority. Scope filtering occurs before fetching, counting or aggregating. The [HR example](appendices/page-builder-contracts.md#hr-example-policy) exercises own-record/direct-report scopes and no self-approval without an HR-specific predicate or custom handler.
