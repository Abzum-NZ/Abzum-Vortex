# Complete definition fixtures

[Worked examples](../../docs/specification/appendices/worked-examples.md) · [Build plan Gate 0](../../docs/build-plan/README.md#gate-0--specification-and-contract-reconciliation)

This directory contains the complete, self-consistent JSON dependency set for CRM and Service Desk. It is a contract gate: the full set must pass the production source parser, deterministic compiler and publication validator before Phase 2 begins.

These files are definition-source documents, not runtime API messages. Their readable snake-case aliases are local to this fixture set. The strict production schemas in [`@vortex/contracts`](../../contracts/README.md) validate the complete closed shape. The shipping [compiler](../../runtime/definition/src/compiler.ts) resolves each alias and version requirement only from the checked-in immutable snapshot, then the [publication validator](../../runtime/definition/src/validation.ts) proves cross-definition semantics before any runtime service may accept the result.

## Contents

| Path | Purpose |
|---|---|
| `fixture-set.json` | Complete manifest, required field types, workflow node catalogue, applications, and cross-application cases. |
| `definition-resolution-snapshot.json` | Permanent fixture identifiers, exact definition versions, and connection operation catalogues injected into compilation. |
| `connection-types/` | Every connection type and operation referenced by either application. |
| `modules/` | Five CRM modules and three Service Desk modules, each independently versioned. |
| `applications/` | CRM and Service Desk definitions with exact module bindings, pages, roles, workflows, pipelines, connections, and interfaces. |
| `scenarios/` | Organisation data and expected outcomes for shared records, collaborative case access, and immediate revocation. |
| `storage/` | Complete record-type-to-table catalog, physical-name rules, application roots, scoped row examples, and collision tests. |
| `validate-fixtures.test.ts` | Shipping-code compilation plus manifest, scenario, storage, coverage, and policy proof. |

## Required command

```text
pnpm fixtures
```

Success means every manifest file, source document, resolved identity, exact version, dependency, relationship, permission, action, event, page, query, workflow node, pipeline transition, connection operation, interface operation, and scenario reference resolves. It also proves complete provenance, all twenty-two field types, the complete safe workflow-node catalogue, a verified incoming-message acknowledgement, and qualified reverse-total relationships.

It also proves that every record type has one storage-contract table, every field has a stable physical column mapping, organisation-shared rows omit an application root, application-contained rows require one, and same-named CRM applications in separate organisations cannot collide.

The validator must never ignore an unresolved reference to accept an incomplete example.

## Cross-application behaviour

- CRM and Service Desk bind the same CRM Organisations and CRM People module versions. Company and Contact records are organisation-wide records, not copies.
- Service Desk cases remain application-contained source records.
- CRM binds the Service Desk Cases definition only so it can understand records received through a grant; the binding itself grants no data access.
- The fixture grant exposes a limited set of case fields, permits changes only to status and priority, and permits only the published public-comment action.
- Revocation removes the case from CRM on the next access check and leaves no recipient record, summary record, search entry, offline value, or cross-request cached value.

## Physical storage rule

- The same validated record-type lineage uses one table across organisations and application bindings.
- `organisation_id` separates every organisation's records. `application_root_id` additionally separates application-contained records.
- A different or structurally forked record-type lineage uses a different table even when every visible name is identical.
- Table and field names come only from immutable storage tokens. Organisation, application, module, record-type, and field display names never become SQL identifiers.

## Change rule

Any fixture change must update its manifest and pass the validator in the same commit. A module or application version changes according to the compatibility rules in the [publication specification](../../docs/specification/03-composition-and-publication.md).
