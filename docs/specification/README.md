# Abzum Vortex platform specification

The [target architecture](../build-plan/target-architecture.md) records the current architecture.
Working instructions are maintained in [AGENTS.md](../../AGENTS.md). The
[architecture decisions](../build-plan/architecture-decisions.md) govern the one flow definition,
engine and protected operations.

This is the approved product contract for the current build scope. Every chapter and appendix states
current behaviour. [Record ownership and lifecycle](appendices/record-ownership-and-lifecycle.md)
defines the ownership and deadline-refresh choices and organisation-bounded
record-type policies. The owner selected one Frontend Rule Designer with
configurable component data flows, flow-level `runAs` authority and reusable custom forms.
Collect-first atomic submission is optional, while configured sequential commits remain explicit.

## How to read this specification

Each section contains a plain-language explanation of the outcome, a diagram showing composition or
working behaviour, functional requirements, and links to related sections. Words such as
"organisation", "module", "application" and "published version" have one meaning throughout; those
meanings are maintained in the [glossary](appendices/glossary.md).

## Specification sections

### Product foundation

1. [Purpose, scope and product boundaries](01-purpose-and-scope.md)
2. [Tenants, organisations, people and sign-in](02-people-organisations-and-sign-in.md)
3. [Platform composition and publication](03-composition-and-publication.md)
4. [Access and permissions](04-access-and-permissions.md)

### Things customers build

5. [Modules, fields and relationships](05-modules-fields-and-relationships.md)
6. [Records and their lifecycle](06-records-and-lifecycle.md)
7. [Applications, navigation, pages and themes](07-applications-pages-and-themes.md)
8. [Forms, actions, rules and events](08-forms-actions-rules-and-events.md)
9. [Workflows and process pipelines](09-workflows-and-pipelines.md)
10. [Queries, reports, search and live updates](10-queries-reports-search.md)

### Supporting services

11. [Files and attachments](11-files-and-attachments.md)
12. [Connections and interfaces](12-connections-and-interfaces.md)
13. A Vortex-provided model or assistant is deliberately outside this release.
14. [Activity history, privacy and retention](14-activity-privacy-and-retention.md)
15. [Entitlements and metering](15-entitlements-and-metering.md)
16. [Copying, sharing, import and export](16-copying-import-export.md)

### Platform safety and delivery

17. [Runtime services, storage and caching](17-runtime-storage-and-caching.md)
18. [Development delivery and environment boundaries](18-delivery-and-testing.md)
19. [Operations, backup and recovery](19-operations-backup-and-recovery.md)
20. [Quality, accessibility and acceptance](20-quality-and-acceptance.md)

### Supporting references

- [Plain-language glossary](appendices/glossary.md)
- [Data contracts](appendices/data-contracts.md)
- [Module and application version-impact policy](appendices/version-impact-policy.md)
- [Core contract boundary](appendices/core-contract-boundary.md)
- [Application packages, custom components and the installation lifecycle](appendices/application-packages.md)
- [Application role review volume](appendices/application-role-review-volume.md)
- [Revised build plan](../build-plan/README.md)

## Authority and change rules

- The approved requirements remain authoritative. A new question blocks only the affected
  behaviour; it does not block unrelated implementation or the whole specification.
- A change to required behaviour updates this specification before the related
  [GitHub issue](https://github.com/orgs/Abzum-NZ/projects/2/views/1) is built.
- A change must check its impact on diagrams, requirements, acceptance examples,
  [data contracts](appendices/data-contracts.md) and [build-plan dependencies](../build-plan/README.md).
  Update the affected sources; do not duplicate an unchanged requirement or edit every document
  merely to record that a review occurred.
- The repository history is the revision record.
- No issue, comment, fixture, or implementation detail silently overrides this specification. Record
  a contradiction in its owning GitHub task and correct the affected specification before
  implementing changed behaviour. Engineering corrections are decided and reviewed by the
  engineering owner; only a genuinely unresolved business/product choice is escalated to the owner.
  Continue unaffected work.
- Every privileged contract must pass the normative
  [core contract admission test](appendices/core-contract-boundary.md#admission-test).
  Business-domain functionality is built as an ordinary Vortex application unless a documented
  platform invariant makes that impossible.
