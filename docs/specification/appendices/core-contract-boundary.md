# Core contract boundary

A flow runs as its fixed `runAs` authority: the initiator, or the saver for a transaction flow. The [run-as contract](frontend-rule-designer.md#run-as) is owned by Access; business-role policy stays in ordinary applications. See the [architecture decisions](../../build-plan/architecture-decisions.md).

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

## Normative rule

Core Vortex contracts may describe only capabilities required to define, validate, publish, secure and execute arbitrary [Vortex applications](../03-composition-and-publication.md). Business-domain functionality — including Abzum's own operational applications — must be implemented using those same Vortex primitives unless a documented platform-level invariant makes that impossible.

This rule applies to runtime services, database schemas, workflow nodes, system interfaces, Studio tools and shipped definitions. Business language belongs in application definitions; it never decides generic core behaviour.

```mermaid
flowchart TB
    CORE[Core Vortex primitives] --> DEFINE[Define and validate]
    CORE --> PUBLISH[Publish and install]
    CORE --> SECURE[Identify and authorise]
    CORE --> EXECUTE[Store, query and execute]
    DEFINE --> APPS[Arbitrary Vortex applications]
    PUBLISH --> APPS
    SECURE --> APPS
    EXECUTE --> APPS
    APPS --> OWN[Abzum operational applications]
    APPS --> CUSTOMER[Customer-built applications]
    FIX[Example fixtures] -. test only .-> CORE
```

## Admission test

A privileged core concept is allowed only when all four answers are **yes**:

1. Is it needed by arbitrary applications rather than one business domain?
2. Would implementing it as ordinary records, actions, pages and workflows make security, publication or execution impossible?
3. Can its owner, scope and enforcement point be named without referring to an example application?
4. Is the smallest safe contract documented in the [core inventory](#core-inventory)?

If any answer is no, the concept is an ordinary application capability. A delivery task cannot create an exception implicitly; an exception requires a specification change, an explicit invariant and a review of affected contracts and dependencies.

## Keep the implementation proportionate

Use the smallest implementation that satisfies the documented behaviour. A new counter, fingerprint, state or abstraction needs a concrete failure case that existing identities, revisions and transactions cannot handle. Reuse existing mechanisms; do not build speculative frameworks or turn every failure case into a separate domain concept. Reviewers must identify unnecessary machinery as well as missing safeguards. Correct the current contract and its consumers together instead of retaining obsolete representation compatibility layers.

Changes to IAM, Access, permissions and migrations preserve existing authorisation and transaction safeguards. A technical change does not itself create another product approval requirement.

For [role changes](groups-and-privileged-access.md#editing-a-role-versus-accepting-permissions), preserve three guarantees: changes are atomic and revision-checked; broadened or restored authority requires explicit fresh acceptance; competing role and assignment changes serialize or refuse as stale without partial effects. Supporting evidence is an implementation detail, not another user-facing approval process. Retain separate continuity checks only where they protect distinct behaviour; merge duplicates, not different safeguards merely because their names sound similar.

The [Access version](data-contracts.md#permission-and-role-contracts) orders access changes. Its change timestamp is observation metadata, not an additional ordering or authorisation decision. Start and expiry checks use current trusted time.

## Core inventory

| Retained capability                                                                           | Platform-level invariant                                                                                                    | Owning boundary                                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stable identities, tenants, organisation hierarchy, organisation accounts and caller contexts | Access cannot be evaluated without a stable actor and organisation boundary.                                                | [Identity](../02-people-organisations-and-sign-in.md)                                          |
| Definitions, modules, applications, fields, pages and publication versions                    | Vortex cannot define or safely publish arbitrary applications without them.                                                 | [Composition](../03-composition-and-publication.md)                                            |
| Permissions, access decisions and grants                                                       | Every protected read or change needs one enforceable decision.                                                                | [Access](../04-access-and-permissions.md)                                                      |
| Records, relationships, queries, events and generic actions                                   | Arbitrary application data needs a common execution language.                                                               | [Records](../06-records-and-lifecycle.md) and [queries](../10-queries-reports-search.md)       |
| One flow definition, the task registry and the Vortex flow engine: generic control flow, record operations and interface steps | Every behaviour is a stored flow definition built from composition primitives, not named business outcomes. The page runner runs page steps, each server segment is one gated request, and every protected step runs through the one protected-operation executor, which rechecks current authority. | [Workflows](../09-workflows-and-pipelines.md) and [Decision 1](../../build-plan/architecture-decisions.md#decision-1--one-flow-definition-one-in-house-flow-engine) |
| Files and connections                                                                         | Arbitrary applications need protected binary data and external interaction boundaries.                                      | [Files](../11-files-and-attachments.md) and [connections](../12-connections-and-interfaces.md) |
| Custom component sandbox                                                                      | Package-bundled browser code must run without Vortex credentials, receive only its mapped fields and start flows only through bindings. | [Application packages](application-packages.md#custom-components)                              |
| Activity evidence, data classification, retention, legal holds and protected removal          | Security and lawful data handling must cover every application record, regardless of which application defined it.          | [Activity and retention](../14-activity-privacy-and-retention.md)                              |
| Entitlement decisions and immutable metering events                                           | Runtime resource limits must be enforceable without understanding how an entitlement was sold or assigned.                  | [Entitlements and metering](../15-entitlements-and-metering.md)                                |
| Storage lineage and cache invalidation                                                        | Definitions need collision-free storage.                                                                                    | [Runtime and storage](../17-runtime-storage-and-caching.md)                                    |
| Runtime bundle per installation revision                                                      | Opening a page must read no definition, so each installation revision compiles once into a bundle under an immutable key that holds declared permission requirements but no decisions. | [Application packages](application-packages.md#caching)                                        |
| Operational status, recovery and audit                                                        | The platform must remain diagnosable and recoverable even when an application is unavailable.                               | [Operations](../19-operations-backup-and-recovery.md)                                          |

## System modules

The [core inventory](#core-inventory) retains the platform concepts that cannot safely be ordinary application records, but applications must still be able to show, link and reason about them. The platform therefore publishes **system modules**: ordinary versioned modules whose **system record types** are read-only projections over the protected core storage. The platform's protected operations are the writes surfaced by application flow bindings. In this specification, a **system module** is such a module; a **system record type** is a read-only record type whose typed fields project protected core storage, with standard create, update and delete refused; and a **protected operation** is a named, authority-checking platform operation that is the only write path over the protected fact. A system record type behaves like any other [record type](../05-modules-fields-and-relationships.md) for lists, forms, links, filters, organisation-added fields, queries and flows, but it has no ordinary create, update or delete path.

A system module does not copy protected facts into application records and does not become a second authorisation authority. The projection resolves the protected fact at request time under the viewer's current authority, and the protected operation remains the only write path, re-checking current authority, target revision and the relevant safeguard in its own transaction. Publishing, installing and versioning a system module follow the ordinary [definition lifecycle](../03-composition-and-publication.md). A later [Module contract change](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1029) declares the system projection storage kind, its typed read-only fields, its registered protected view or function and its revision field; this section defines the boundary those contracts must preserve.

A system projection may declare `refresh_while`: a choice field, its pending values and a bounded
`interval_milliseconds` (1,000–60,000). Publication resolves the field identity and refuses values
outside its declared choices. A mounted table or record detail rereads through the existing
permission-checked placement read only while it displays a pending choice on screen. Reads are
serial, stop in a hidden browser tab and stop when the displayed state completes or fails. No
hidden field, off-screen placement or later query page is fetched to decide whether to refresh.
The App Store declares queued, updating and retrying record updates this way and displays the
records processed beside their status; the upgrade result confirms the installation independently
of that background work.

### Concept mapping

| Core concept | Stays protected in the core | Read-only system record type | Protected operations (the only writes) | What becomes ordinary definition |
| --- | --- | --- | --- | --- |
| People (organisation accounts) | Global identity, cluster-local identity projection, organisation accounts, status and profile, and the Access decision that scopes them | Organisation-account (person) projection for the current organisation, with its Group membership | Invitation acceptance and account creation/reactivation; account suspend, reactivate and close; trusted appointment | Organisation Administration and IAM person lists, forms, links and flows; organisation-added person fields reuse [module extension points](../05-modules-fields-and-relationships.md#extension-points) |
| Invitations | Raw invitation secret, which is never stored, and its fingerprint, single-use acceptance and expiry rules | Organisation-invitation projection (address, expiry, state), never the secret | Create and revoke an invitation; accept an invitation | Organisation Administration invitation list, create form and row actions |
| Groups and memberships | Group identity and metadata, memberships, and delegated management scope | Group projection with its current members; the person projection shows Group membership | Create or edit Group metadata; add and remove membership; grant, replace and revoke management delegation | IAM Roles and Groups pages, lists, forms and selection flows |
| Permissions and roles | Permission declarations and their exact owning definition, organisation catalogue availability, immutable role templates and acceptance state | Permission-catalogue entry and role/template projection with accepted configuration and safe policy settings | Register, upgrade, reactivate and withdraw an application; accept a template; create, edit and retire a local role | IAM catalogue browsing, custom-role pages and availability lists |
| Assignments | Effective direct and Group assignments, their exact role/permission references, revisions and source evidence | Assignment projection (holder, role, time window, revision, stored state) | Grant, remove and replace an assignment; accept a changed supplied role | IAM assignment lists, access-request records and the links between them |
| Delegations | Bounded delegation authorities | Delegation-authority projection | Grant, replace and revoke a delegation | IAM delegated-scope administration journey |
| Tenants and organisations | Tenant, organisation hierarchy, lifecycle state, tenant-administrator assignments and permanent-steward facts | Tenant-structure and organisation projection (identity, parent, lifecycle, display name; no organisation application data) | Create, move, suspend, reactivate and archive an organisation; suspend and reactivate a tenant; appoint a tenant administrator | Tenant Administration structure pages, forms, lists and protected row actions |
| Settings and installed applications | Runtime and localisation setting values and their owner initializer; active application registrations, exact releases and catalogue availability | Organisation-settings projection and installed-application registration projection | Update runtime settings; register, upgrade, reactivate and withdraw an application | Organisation Administration settings form and application list; the extendable settings record ([#1045](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1045)) |
| Activity entries | Activity evidence writers, retention rules and legal holds | Activity-entry projection under the viewer's current authority | Protected removal; legal-hold set and clear | Activity lists, detail pages and audit filters in any application |
| Files and connections | File storage and its download grants; connection instances, their encrypted credentials and allowed operations | File-metadata projection and connection-instance projection, never credentials or secret values | Upload, revoke and remove a file; create, update, test and rotate a connection; bind a connection to an application | Attachments, file lists, connection settings pages |

### System record type rules

All system record types follow the same boundary:

1. **Never shared across organisations.** A system record type is scoped to exactly one organisation, and tenant structure to exactly one tenant. It is never named by an inter-application grant, inherited from a parent organisation, or copied into another organisation.
2. **Never cached across requests.** A system-record value is resolved live for each request. No cross-request cache, search index, materialised report result, continuation snapshot or offline copy holds it, so a query over a system record type always bypasses the cross-request data-result cache ([runtime and caching](../17-runtime-storage-and-caching.md#cache-model)). Presentation may be cached, but every live invalidation re-runs the current query.
3. **Read only through the one query path under the viewer's current authority.** Every system-record read uses the validated [query contract](../10-queries-reports-search.md#query-contract): organisation isolation, record visibility, field permissions and the read permission the system record type declares are applied before rows, counts, groups or totals are produced. A system record type adds no new reader, endpoint or permission vocabulary, and its declared filterable and sortable fields still obey their field rules.
4. **Never written through the record.** The one [record-change command](../06-records-and-lifecycle.md#record-change-command) refuses to create, change, delete or restore a system record, and publication refuses a form, action or flow that binds a record task to a system record type's projected fields. Every change goes through the named protected operation, which rechecks current actor authority, target revision and the relevant safeguard, and commits atomically with any Access-version change it causes and its Activity evidence. An editable request, import, direct URL or agent call cannot write the projection.

A system record type is extended only with organisation-added fields through the ordinary module [extension points](../05-modules-fields-and-relationships.md#extension-points). Their values are ordinary organisation data keyed to the system record and changed through the record-change command under their own field permissions; they never change the protected fact, and the protected storage and its write path never widen.

The administration applications are ordinary definitions over system modules, delivered as **system applications**: IAM, Organisation Administration, Tenant Administration and the Landing Zone. They supply modules, pages, lists, forms, actions and flows, and the core contains no portal-specific page or reader. Under [Decision 11](../../build-plan/architecture-decisions.md#decision-11--building-installing-and-system-applications-are-permission-gated), system applications are platform packages installed when an organisation is created, and they cannot be uninstalled. People whose role grants `platform.organization.system_applications.manage` customise them through extension fields, theme, navigation and their own dependent applications, or through an organisation-owned customised copy ([#1058](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1058)) that replaces the system application's installation. The protected operations and their bindings stay platform-owned: no customisation adds, removes or retargets a protected-operation binding, and platform upgrades never overwrite customisations.

## Ordinary applications, not core domains

The following are built from the retained primitives:

| Application concern                                                  | Composition                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial billing, pricing, subscriptions, invoices and payments    | Modules and records plus [connections](../12-connections-and-interfaces.md) and [workflows](../09-workflows-and-pipelines.md).                                                                                                                 |
| Personal start page, favourites, bookmarks and recently used         | The Landing Zone system application: organisation-account-owned records, pages, flows and a shell slot. Core supplies only the permitted-applications read, the organisation default application and generic link blocks.                     |
| Business approvals and work queues                                   | Request and decision record types, pages, permissions and named actions.                                                                                                                                                                       |
| IAM access requests and administration journeys                      | The ordinary [IAM application](iam-application.md) owns request records and action flows. Protected Access owns effective assignments and delegation because editable business records cannot safely be their own authorisation authority. |
| Tasks, comments, tags, calendar entries and notifications            | Ordinary record types and actions.                                                                                                                                                                                                             |
| Organisation legal details, contacts, branding and business calendar | The Organisation Administration system application, using ordinary fields and pages.                                                                                                                                                             |
| Privacy request case management                                      | An ordinary application whose protected-operation bindings invoke protected discovery, export and removal operations.                                                                                                                         |
| Tenant, organisation and application notices                         | An ordinary Notices application rendered through a reusable accessible banner block.                                                                                                                                                           |
| Incident and customer-communication records                          | Ordinary operations or service applications.                                                                                                                                                                                                  |

```mermaid
flowchart LR
    R[Records] --> APP[Ordinary application]
    A[Actions] --> APP
    P[Pages] --> APP
    W[Flows] --> APP
    C[Connections] --> APP
    APP --> B[Commercial operations]
    APP --> Q[Approval queues]
    APP --> N[Notices]
    APP --> PR[Privacy operations]
```

## Source and runtime separation

The production [definition-source boundary](data-contracts.md#runtime-and-definition-source-layers) uses readable builder keys and is capability-complete for modules, applications and platform connection types. The pure [definition compiler](../../../packages/platform/src/definition/compiler.ts) resolves that source to the stable identifiers used by runtime contracts without semantic loss. The schemas and compiler are generic platform code; shipped application and module definitions live in `packages/definitions`.

Core source must not contain an example application's name, module name, record type, field, workflow or connection key. Automated source guards enforce this rule. Test fixtures may assert example-specific outcomes because they are consumers of the generic platform, not inputs to its semantics.
