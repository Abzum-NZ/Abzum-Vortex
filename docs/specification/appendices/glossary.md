# Plain-language glossary

[Specification index](../README.md) · [Decision register](decisions.md)

```mermaid
flowchart TD
    IDENTITY[Global identity] --> ACCOUNT[Organisation account]
    ORG[Organisation] --> ACCOUNT
    ORG --> APP[Application]
    APP --> MODULE[Module]
    MODULE --> TYPE[Record type]
    TYPE --> RECORD[Record]
    APP --> PAGE[Page]
    APP --> WORKFLOW[Workflow]
```

| Term | Meaning and governing section |
|---|---|
| Access decision | The allow-or-refuse answer described in [Access and permissions](../04-access-and-permissions.md). |
| Access grant | A source organisation's limited, approved, and revocable permission for a named recipient context to use specified records, actions, and fields under [Shared-record access](../04-access-and-permissions.md#shared-record-access). |
| Action | A named operation that participates in one [record save](../08-forms-actions-rules-and-events.md#actions). |
| Application | A published user experience composed from modules, described in [Applications, navigation, pages and themes](../07-applications-pages-and-themes.md). |
| Application binding | Application-specific settings attached to a reusable module field or record type, described in [Modules, fields and relationships](../05-modules-fields-and-relationships.md#application-level-bindings). |
| Application role | A collection of permissions inside one [application](../04-access-and-permissions.md#application-roles). |
| Approval request | A protected request whose immutable decisions allow an owning platform service to perform one exact governed action under the [approval contract](data-contracts.md#approval-request-contract). |
| Assistant | The optional model-assisted experience governed by [Assistant and model-assisted work](../13-assistant.md). |
| Attachment | A record field linking one or more files under [Files and attachments](../11-files-and-attachments.md). |
| Block | A platform-supplied page component with a validated setting contract, described in [Applications, navigation, pages and themes](../07-applications-pages-and-themes.md#page-composition). |
| Builder | A person authorised to edit definitions. |
| Cache | A temporary copy used to avoid repeated work under [Runtime services, storage and caching](../17-runtime-storage-and-caching.md#cache-model). |
| Cluster | One operated Vortex runtime and its organisation database, file store, queue, and service deployment. Clusters share published contracts and an environment's identity authority but remain separate security and availability boundaries under [Vortex federation](../17-runtime-storage-and-caching.md#vortex-federation-between-clusters). |
| Cluster directory | The protected catalogue of cluster identifiers, approved addresses, regions, supported versions, status, and public signing keys under [Cluster identity and discovery](../17-runtime-storage-and-caching.md#cluster-identity-and-discovery). It stores no customer records. |
| Connection | An organisation's authorised link to another system under [Connections and programmable interfaces](../12-connections-and-interfaces.md). |
| Connection instance | One organisation's encrypted credentials and grants for a published connection type. |
| Connection type | A reusable definition of authentication, allowed operations and safety policy. |
| Contained component | A page, field, rule, workflow, or similar item published with its root definition under [Platform composition and publication](../03-composition-and-publication.md#definition-ownership). |
| Concurrency number | A number changed on every record update so a later edit is not silently overwritten, described in [Records and their lifecycle](../06-records-and-lifecycle.md#concurrent-changes). |
| Definition | A versioned description of structure or behaviour. Root definitions and publication are described in [Platform composition and publication](../03-composition-and-publication.md). |
| Draft | The editable, non-live version of a root definition. |
| Engine | Earlier name for a code ownership boundary. This specification uses **platform service**; see [Runtime services, storage and caching](../17-runtime-storage-and-caching.md#platform-services-inside-the-codebase). |
| Event | A committed statement that something happened, described in [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md#events). |
| Event outbox | Database records written with a business save and later delivered safely. |
| Field | One named value on a record type, described in [Modules, fields and relationships](../05-modules-fields-and-relationships.md#common-field-properties). |
| Federation | A signed Vortex-to-Vortex request that lets a recipient use source-owned records across clusters without database credentials or a persistent recipient copy under [Vortex federation](../17-runtime-storage-and-caching.md#vortex-federation-between-clusters). |
| Gallery | A reviewed catalogue of definition packages under [Copying, sharing, import and export](../16-copying-sharing-import-export.md#gallery). |
| Global identity | One human sign-in that can be linked to a separate account in several organisations under [People, organisations and sign-in](../02-people-organisations-and-sign-in.md). |
| Guided form | A form split into two to twenty steps and committed once, described in [Applications, navigation, pages and themes](../07-applications-pages-and-themes.md#forms-and-guided-forms). |
| Interface | A versioned catalogue of operations for approved software callers, described in [Connections and programmable interfaces](../12-connections-and-interfaces.md#programmable-interfaces). |
| Legal hold | A protected instruction that prevents permanent removal of matching data under [Activity history, privacy and retention](../14-activity-privacy-and-retention.md#legal-holds). |
| Module | A reusable description of business data and meaning, described in [Modules, fields and relationships](../05-modules-fields-and-relationships.md). |
| Organisation | One customer's private workspace. The user interface does not use the technical word “tenant.” |
| Organisation account | One global identity's separate account inside one organisation, with its own status, profile, roles, teams, preferences, and application access. Earlier drafts called this a membership. |
| Organisation role | A collection of organisation-wide permissions under [Access and permissions](../04-access-and-permissions.md#organisation-roles). |
| Page | A published application screen type and block layout under [Applications, navigation, pages and themes](../07-applications-pages-and-themes.md#page-types). |
| Permission | One permanently named right that a role may grant. |
| Process pipeline | The ordered business stages of a record under [Workflows and process pipelines](../09-workflows-and-pipelines.md#process-pipelines). |
| Public operation | A narrowly published page or interface operation that does not require an organisation account. |
| Published version | An immutable, numbered snapshot used by live requests under [Platform composition and publication](../03-composition-and-publication.md#draft-and-published-versions). |
| Query | A validated request for bounded rows, groups or totals under [Queries, reports, search and live updates](../10-queries-reports-search.md#query-contract). |
| Recipient assertion | A short-lived statement signed by the recipient cluster confirming the current person, organisation account, application, roles, access version, intended source, and grant under the [federation contracts](data-contracts.md#recipient-assertion). |
| Recipient grant mirror | Non-content routing and status information stored by the recipient cluster; the source grant remains authoritative under the [federation contracts](data-contracts.md#recipient-grant-mirror). |
| Record | One organisation-owned instance of a record type under [Records and their lifecycle](../06-records-and-lifecycle.md). |
| Record type | A named business object and its fields inside a module. |
| Root definition | One independently published module, application, theme, connection type, interface, or organisation role. |
| Rule | Immediate typed logic evaluated during a record save under [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md#rules). |
| Saved view | A saved query and arrangement under [Queries, reports, search and live updates](../10-queries-reports-search.md#saved-views). |
| Saved sharing condition | A published and tested condition that defines which changing source records a grant may cover under [Record sharing](../16-copying-sharing-import-export.md#scope-and-saved-sharing-conditions). |
| Sensitive field | A field carrying higher-risk personal or confidential data under [Activity history, privacy and retention](../14-activity-privacy-and-retention.md#personal-data-classification). |
| Soft deletion | Recoverable deletion before permanent removal under [Records and their lifecycle](../06-records-and-lifecycle.md#deletion-and-restoration). |
| Theme | Published, validated design values used by an application under [Applications, navigation, pages and themes](../07-applications-pages-and-themes.md#themes). |
| Vortex Identity Authority | The environment-wide sign-in authority that gives one person a stable global identity across clusters while each cluster keeps its own organisation accounts under [Identity across clusters](../02-people-organisations-and-sign-in.md#identity-across-clusters). |
| Workflow | Durable background work executed with Kestra under [Workflows and process pipelines](../09-workflows-and-pipelines.md). |
