# Complete definition fixtures

[Worked examples](../../docs/specification/appendices/worked-examples.md) · [Build plan Gate 0](../../docs/build-plan/README.md#gate-0--specification-and-contract-reconciliation)

This directory contains the complete, self-consistent JSON dependency set for CRM and Service Desk. It is a contract gate: the full set and its exhaustive validator must pass before Phase 1 engine code begins.

## Contents

| Path | Purpose |
|---|---|
| `fixture-set.json` | Complete manifest, required field types, workflow node catalogue, applications, and cross-application cases. |
| `connection-types/` | Every connection type and operation referenced by either application. |
| `modules/` | Five CRM modules and three Service Desk modules, each independently versioned. |
| `applications/` | CRM and Service Desk definitions with exact module bindings, pages, roles, workflows, pipelines, connections, and interfaces. |
| `scenarios/` | Organisation data and expected outcomes for shared records, collaborative case access, and immediate revocation. |
| `validate-fixtures.mjs` | Exhaustive reference, dependency, coverage, and policy validation. |

## Required command

```text
node testing/fixtures/validate-fixtures.mjs
```

Success means every manifest file, root, version, dependency, relationship, permission, action, event, page, query, workflow node, pipeline transition, connection operation, interface operation, and scenario reference resolves. It also proves coverage of all twenty-two field types and the complete safe workflow-node catalogue.

The validator must never ignore an unresolved reference to accept an incomplete example.

## Cross-application behaviour

- CRM and Service Desk bind the same CRM Organisations and CRM People module versions. Company and Contact records are organisation-wide records, not copies.
- Service Desk cases remain application-contained source records.
- CRM binds the Service Desk Cases definition only so it can understand records received through a grant; the binding itself grants no data access.
- The fixture grant exposes a limited set of case fields, permits changes only to status and priority, and permits only the published public-comment action.
- Revocation removes the case from CRM on the next access check and leaves no recipient record, summary record, search entry, offline value, or cross-request cached value.

## Change rule

Any fixture change must update its manifest and pass the validator in the same commit. A module or application version changes according to the compatibility rules in the [publication specification](../../docs/specification/03-composition-and-publication.md).
