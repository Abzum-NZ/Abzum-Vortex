# Coverage and traceability map

[Specification index](../README.md) · [Revised build plan](../../build-plan/README.md) · [GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2/views/1)

This map proves that the rewrite did not silently drop the earlier [Platform Specification](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4) or [Build Plan](https://claude.ai/code/artifact/58852ead-2acc-4ca6-a693-6cb03705bcef). “Changed” means the earlier wording was contradictory, incomplete, unsafe, or inconsistent with the repository.

```mermaid
flowchart LR
    OLD[Earlier specification<br/>33 chapters and 5 appendices] --> MAP[Coverage map]
    PLAN[Earlier build plan<br/>10 phases and linked briefs] --> MAP
    BOARD[GitHub Project<br/>issues and milestones] --> MAP
    MAP --> NEW[Specification 2.0 sections]
    MAP --> DEC[Open decisions]
    NEW --> BUILD[Revised build plan]
    DEC --> BUILD
```

## Earlier specification coverage

| Earlier chapter | New governing section | Treatment |
|---|---|---|
| 1. What Abzum Vortex is | [Purpose, scope and product boundaries](../01-purpose-and-scope.md) | Rewritten around outcomes, boundaries, and principles. |
| 2. Tenants and people | [People, organisations and sign-in](../02-people-organisations-and-sign-in.md), [Access and permissions](../04-access-and-permissions.md), [Quality and acceptance](../20-quality-and-acceptance.md) | “Tenant” removed from user language; sign-in conflict and isolation-test flaw corrected. |
| 3. Tenant Portal | [People, organisations and sign-in](../02-people-organisations-and-sign-in.md), [Applications](../07-applications-pages-and-themes.md), [Entitlements](../15-entitlements-and-metering.md) | Replaced by a locked, ordinary Tenant Administration application that calls narrowly protected platform operations. |
| 4. What a module is | [Modules, fields and relationships](../05-modules-fields-and-relationships.md) | Preserved and clarified. |
| 5. Fields | [Modules, fields and relationships](../05-modules-fields-and-relationships.md), [Data contracts](data-contracts.md#field-contract) | All 22 types retained; public display and application binding added. |
| 6. Relationships and deletion | [Modules, fields and relationships](../05-modules-fields-and-relationships.md#relationships), [Records](../06-records-and-lifecycle.md#deletion-and-restoration) | Required links block deletion unless dependent-child soft-delete is explicit. |
| 7. Actions, permissions and events | [Access](../04-access-and-permissions.md), [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md) | Separated by concern. |
| 8. Extending a module | [Composition and publication](../03-composition-and-publication.md), [Modules](../05-modules-fields-and-relationships.md), [Copying and sharing](../16-copying-sharing-import-export.md) | Extension points remain declarative; customer executable code remains excluded. |
| 9. What an application is | [Applications](../07-applications-pages-and-themes.md) | Preserved with one publication root. |
| 10. Navigation and pages | [Applications](../07-applications-pages-and-themes.md) | Six page types and four list arrangements retained. |
| 11. Look and feel | [Themes](../07-applications-pages-and-themes.md#themes), [Quality](../20-quality-and-acceptance.md) | Accessibility made part of publication and acceptance. |
| 12. Permissions on the page | [Access](../04-access-and-permissions.md), [Applications](../07-applications-pages-and-themes.md) | Page visibility explicitly secondary to server enforcement. |
| 13. What happens when a record is saved | [Records](../06-records-and-lifecycle.md#save-sequence) | Transaction sequence and concurrency token made explicit. |
| 14. Rules and instant automation | [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md) | Preserved; unsafe condition dropping prohibited. |
| 15. Background work | [Workflows and pipelines](../09-workflows-and-pipelines.md), [Runtime](../17-runtime-storage-and-caching.md) | Callback, duplicate protection, state authority, and dispatcher supplied. |
| 16. Guided forms and process pipelines | [Applications](../07-applications-pages-and-themes.md#forms-and-guided-forms), [Workflows and pipelines](../09-workflows-and-pipelines.md#process-pipelines) | UI and execution dependencies reconciled. |
| 17. Reading data | [Queries, reports, search and live updates](../10-queries-reports-search.md) | “Saved view” is the one term; invalid predicates fail closed. |
| 18. Search | [Queries, reports, search and live updates](../10-queries-reports-search.md#search) | Access recheck and freshness decision added. |
| 19. Files and attachments | [Files and attachments](../11-files-and-attachments.md) | Broad detected kinds plus optional extension allowlist replace conflicting settings. |
| 20. Connections to other systems | [Connections and programmable interfaces](../12-connections-and-interfaces.md) | OAuth lifecycle, request forgery protection, retries, redaction, and inbound replay supplied. |
| 21. Application interface and assistant | [Connections and interfaces](../12-connections-and-interfaces.md), [Product boundaries](../01-purpose-and-scope.md#product-boundaries) | Interfaces remain; all artificial-intelligence functionality is outside the release. |
| 22. Activity, personal data and retention | [Activity, privacy and retention](../14-activity-privacy-and-retention.md) | Data inventory, organisation-scoped erasure, global identity closure, legal holds, backups, search, caches and workflows added. |
| 23. Billing and usage | [Entitlements and metering](../15-entitlements-and-metering.md), [Core boundary](core-contract-boundary.md) | Commercial billing is an ordinary application; core retains only generic entitlement decisions and metering evidence. |
| 24. Delivery | [Delivery environments, database changes and testing](../18-delivery-and-testing.md) | Pull requests use database-free checks; database and access suites run after merge to Testing and before promotion. |
| 25. The engines | [Runtime services, storage and caching](../17-runtime-storage-and-caching.md#platform-services-inside-the-codebase), [Build plan](../../build-plan/README.md) | Sixteen ownership boundaries retained; dependency graph corrected. |
| 26. How definitions work | [Composition and publication](../03-composition-and-publication.md), [Data contracts](data-contracts.md#published-definition-envelope) | Modules and applications version independently; other components are contained or live administration. |
| 27. Module and record-type definitions | [Modules](../05-modules-fields-and-relationships.md), [Data contracts](data-contracts.md#module-and-record-type-contracts) | Preserved in consolidated contract. |
| 28. Field and relationship definitions | [Modules](../05-modules-fields-and-relationships.md), [Files](../11-files-and-attachments.md), [Data contracts](data-contracts.md#field-contract) | All types retained; attachment and loaded-option conflicts corrected. |
| 29. Application, navigation and page definitions | [Applications](../07-applications-pages-and-themes.md), [Data contracts](data-contracts.md) | Components publish with application; six page types retained. |
| 30. Behaviour definitions | [Forms, actions, rules and events](../08-forms-actions-rules-and-events.md), [Workflows](../09-workflows-and-pipelines.md) | Safe workflow-node catalogue and event ordering retained; model-assisted steps are outside the release. |
| 31. Access and identity definitions | [People](../02-people-organisations-and-sign-in.md), [Access](../04-access-and-permissions.md), [Data contracts](data-contracts.md#tenant-identity-and-organisation-account-records) | Tenant hierarchy, global identity, separate organisation accounts, application access, access-version ownership, and SQL/server split clarified. |
| 32. Service definitions | [Themes](../07-applications-pages-and-themes.md#themes), [Files](../11-files-and-attachments.md), [Connections](../12-connections-and-interfaces.md) | Split by service, conflicting attachment contract removed, and AI scope removed. |
| 33. Caching and request speed | [Runtime services, storage and caching](../17-runtime-storage-and-caching.md#cache-model) | Distributed-cache feasibility corrected; shared static asset exception made explicit. |
| Appendix A. CRM example | [Worked examples](worked-examples.md#crm-application) | Retained as a contract fixture; missing actions must be supplied. |
| Appendix B. CRM application example | [Worked examples](worked-examples.md#crm-application) | Rewritten as part of the complete CRM and Service Desk dependency fixture set. |
| Appendix C. Glossary | [Plain-language glossary](glossary.md) | Rewritten and linked. |
| Appendix D. Decisions register | [Decision register](decisions.md) | Kept clear after resolved choices are incorporated into permanent requirements. |
| Appendix E. Data model | [Data contracts](data-contracts.md) | Missing concurrency, lifecycle, activity, workflow, interface and cache-version contracts supplied. |

## Earlier build-plan coverage

| Earlier phase | Revised phase or gate | Main correction |
|---|---|---|
| Prerequisites | [Gate 0](../../build-plan/README.md#gate-0--decisions-and-platform-readiness) | Adds specification decisions, complete fixtures, branch checks and current M0 work. |
| 1. Contracts | [Phase 1](../../build-plan/README.md#phase-1--contracts-and-complete-fixtures) | Runs only after blocking foundation decisions; validates complete fixtures. |
| 2. Definition and Identity | [Phase 2](../../build-plan/README.md#phase-2--definition-and-identity) | Neutral bootstrap sign-in and application sign-in are separated. |
| 3. Access | [Phase 3](../../build-plan/README.md#phase-3--access) | SQL decision function and server adapter replace impossible shared TypeScript/SQL implementation. |
| 4. Module and Record | [Phase 4](../../build-plan/README.md#phase-4--module-and-record) | Incompatible field changes use migration; lifecycle edge cases are explicit. |
| 5. Query, Rule and Event | [Phase 5](../../build-plan/README.md#phase-5--query-rule-and-event) | Unsafe filters fail closed; durable queue and wake-up runtime supplied. |
| 6. App, Theme and Page | [Phase 6](../../build-plan/README.md#phase-6--application-theme-and-page) | Owns complete pipeline definition and visible pipeline controls. |
| 7. Workflow | [Phase 7](../../build-plan/README.md#phase-7--workflow-and-pipeline-execution) | Depends on Phase 6; Kestra owns execution status and protected-operation correlation is required. |
| 8. Search and File | [Phase 8](../../build-plan/README.md#phase-8--search-and-file) | Can start after Phase 4, but file UI and purge work have explicit later dependencies. |
| 9. Connection and Interface | [Phase 9](../../build-plan/README.md#phase-9--connections-and-interfaces) | Adds OAuth, network safety, interface ranges and federation transport. |
| 10. Extension, distribution and operations | [Phases 10–13](../../build-plan/README.md#phase-10--copy-gallery-sharing-import-and-export) | Split into distribution, protected data handling, entitlements/metering, and operations because the original phase was too broad. |

## Identified-review finding coverage

| Review finding | Resolution link |
|---|---|
| Definition ownership contradiction | [Module and application versions](../03-composition-and-publication.md#definition-ownership-and-versions) |
| Permission wildcard contradiction | [Controlled permission names](../04-access-and-permissions.md#permission-names) |
| Attachment contract contradiction | [Canonical attachment settings](../11-files-and-attachments.md#canonical-attachment-settings) |
| Missing public-safe field | [Public access](../04-access-and-permissions.md#public-access) |
| Sign-in tenant contradiction | [One global identity with organisation-local accounts](../02-people-organisations-and-sign-in.md#identity-across-clusters) |
| Workflow-loaded module options | [Application bindings](../05-modules-fields-and-relationships.md#application-level-bindings) |
| Distributed cache feasibility and ownership | [Cache model](../17-runtime-storage-and-caching.md#cache-model) |
| One TypeScript/SQL access function | [Where access is enforced](../04-access-and-permissions.md#where-access-is-enforced) |
| Invalid owner rerun of whole isolation suite | [Organisation separation suite](../20-quality-and-acceptance.md#organisation-separation-suite) |
| Event sequence loss | [Delivery guarantees](../08-forms-actions-rules-and-events.md#delivery-guarantees) |
| Missing workflow callback contract | [Protected workflow operation](data-contracts.md#workflow-execution-reference-and-protected-operation) |
| Missing event dispatcher runtime | [Delivery guarantees](../08-forms-actions-rules-and-events.md#delivery-guarantees) |
| Incorrect Phase 7 dependency | [Revised dependency map](../../build-plan/README.md#dependency-map) |
| Incomplete Phase 8 dependencies | [Phase 8](../../build-plan/README.md#phase-8--search-and-file) |
| Unsafe filter dropped | [Query contract](../10-queries-reports-search.md#query-contract) |
| Stale prepared-view terminology | [Saved views](../10-queries-reports-search.md#saved-views) |
| Duration without field type | [Calendar field mapping](../05-modules-fields-and-relationships.md#field-types) |
| Required link emptied on delete | [Relationships](../05-modules-fields-and-relationships.md#relationships) |
| Multi-currency result shape | [Calculations and totals](../05-modules-fields-and-relationships.md#calculations-and-totals) |
| Soft-delete, uniqueness and restore | [Uniqueness](../06-records-and-lifecycle.md#uniqueness) |
| Missing concurrency contract | [Record storage contract](data-contracts.md#record-storage-contract) |
| Domain schemas could accept aliases, incomplete publications, ambiguous owners, or mismatched federation payloads | The canonical [published-definition envelope](data-contracts.md#published-definition-envelope), [record ownership contract](data-contracts.md#record-storage-contract), [calendar mapping](data-contracts.md#field-contract), and [federated request contract](data-contracts.md#federated-request-envelope) are strict and discriminated. The [runtime and definition-source split](data-contracts.md#runtime-and-definition-source-layers) makes [#15](https://github.com/Abzum-NZ/Abzum-Vortex/issues/15) responsible for a capability-complete authored boundary; fixture-shaped schemas remain test-only until then. |
| Definition validation could expose raw library messages, submitted values, internal paths, identifiers, diagnostics, or fixture-specific assumptions | The [versioned definition-validation error contract](data-contracts.md#definition-validation-errors), executable [catalogue and translators](../../../contracts/src/validation-errors.ts), and [author guide](../../../contracts/VALIDATION_ERRORS.md) provide generic catalogue-owned wording, caller-mapped safe locations, deterministic output, a protected diagnostic boundary, and adversarial coverage under [#13](https://github.com/Abzum-NZ/Abzum-Vortex/issues/13). |
| Per-organisation or name-derived record tables would collide and multiply migrations | [Storage identity and application use](../05-modules-fields-and-relationships.md#storage-identity-and-application-use), [record-table allocation](../17-runtime-storage-and-caching.md#record-table-allocation), and the [storage fixture](../../../testing/fixtures/storage/record-storage-layout.json) |
| Incomplete fixtures | [Worked examples](worked-examples.md#complete-fixture-set) |
| Model step absent from closed list | [AI excluded from product boundaries](../01-purpose-and-scope.md#product-boundaries) |
| Assistant safety and retention gaps | Resolved by removing AI functionality from the release in [Product boundaries](../01-purpose-and-scope.md#product-boundaries). |
| Connection security and lifecycle gaps | [Connections](../12-connections-and-interfaces.md) |
| Interface compatibility range missing | [Interface versions](../12-connections-and-interfaces.md#interface-versions) |
| Privacy and erasure incomplete | [Organisation-scoped erasure and global identity closure](../14-activity-privacy-and-retention.md#protected-personal-data-operations) |
| Commercial lifecycle incorrectly privileged | Corrected by the [core contract boundary](core-contract-boundary.md); commercial lifecycle is an ordinary application and cannot define core access or retention. |
| Whole-organisation restore conflated with record import | [Complete archive and restore](../16-copying-sharing-import-export.md#complete-organisation-archive-and-restore) |
| Delivery plan disagrees with repository | [Testing-first database checks](../18-delivery-and-testing.md) |
| Arbitrary field retype conflict | [Field changes after publication](../05-modules-fields-and-relationships.md#field-changes-after-publication) |
| Unreproducible performance target | [Performance measurements](../20-quality-and-acceptance.md#performance-measurement) |
| Original Phase 10 too large | [Revised phases 10–13](../../build-plan/README.md#phase-10--copy-gallery-sharing-import-and-export) |
| Supabase capabilities underused or ambiguously owned | [Supabase capability policy](../17-runtime-storage-and-caching.md#supabase-capability-policy), [local and Testing verification](../18-delivery-and-testing.md#supabase-development-and-verification), and [database platform safeguards](../19-operations-backup-and-recovery.md#database-platform-safeguards) assign Auth, row rules, Queue, Webhooks, Realtime, Storage, tests, advisers and recovery without creating duplicate workflow, server or secret systems. |
| Production recovery retention and database allowlisting unclear | [Backup](../19-operations-backup-and-recovery.md#backup) fixes continuous seven-day Supabase PITR plus hourly encrypted R2 backups with 48-hour requested expiry; [database platform safeguards](../19-operations-backup-and-recovery.md#database-platform-safeguards) defer CIDR restrictions until both database callers have stable egress and exclude read replicas from the first release. |

## Contributed sharing-change review

| Proposed addition | Review outcome and governing link |
|---|---|
| Global identity with organisation-local accounts | Contracts separate the global identity from each [organisation account](data-contracts.md#tenant-identity-and-organisation-account-records). |
| Definition sharing versus record sharing | Retained and clarified in [composition](../03-composition-and-publication.md#definition-distribution-is-not-record-access) and [record sharing](../16-copying-sharing-import-export.md#record-sharing). |
| Cross-module relationships | Retained with stable dependency resolution and the same-organisation relationship boundary in [modules and relationships](../05-modules-fields-and-relationships.md#cross-module-relationships). |
| Hierarchical access grants | Revised to one explicit scope per grant, one named recipient application and role set, explicit actions and field allowlists, and protected grant consent in the [grant contract](data-contracts.md#access-grant-contract). |
| Editable business approval record activates grants | Corrected: only the Access service can record immutable consent evidence and activate a grant under the [grant-consent contract](data-contracts.md#grant-consent-contract). Ordinary approvals remain application records and workflows. |
| Dynamic filter executed inside every row rule | Replaced with version-pinned published saved sharing conditions or narrower scopes in the [grant contract](data-contracts.md#access-grant-contract). |
| Cross-organisation sharing as settled first-release scope | Defined as one local-and-cross-cluster product capability with both-side consent, a named application and roles, explicit actions and fields, no live re-sharing, and source-executed search, reports, and approved export in [record sharing](../16-copying-sharing-import-export.md#record-sharing). |
| Cross-cluster native protocol selected now | Uses a signed, versioned, source-authoritative [Vortex Federation API](../17-runtime-storage-and-caching.md#vortex-federation-between-clusters), with no persistent recipient copy, Phase 9 transport in [issue #157](https://github.com/Abzum-NZ/Abzum-Vortex/issues/157), and Phase 10 record execution in [issue #156](https://github.com/Abzum-NZ/Abzum-Vortex/issues/156). |
| Sharing coverage | Covers query, search, report, export, cache, file, protected data handling, activity, identity, recipient discovery, metering allocation, grant consent, audience, condition versioning, action/field allowlists, non-re-sharing, and boundary tests through the [shared-record specification](../04-access-and-permissions.md#shared-record-access) and [acceptance suite](../20-quality-and-acceptance.md#organisation-separation-suite). |

## Completion check

All 33 earlier chapters, all five earlier appendices, all ten earlier phases, and every material review finding have a destination above. A future edit that introduces an uncovered requirement must add a row before the specification can be published.
