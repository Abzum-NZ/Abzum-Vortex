# Complete definition fixtures

[Worked examples](../../docs/specification/appendices/worked-examples.md) · [Build plan Gate 0](../../docs/build-plan/README.md#gate-0--specification-and-contract-reconciliation)

This directory contains the complete, self-consistent JSON dependency set for CRM and Service Desk. The eight current Module sources use source and validation contract `2.0.0`; the two Application sources and three connection-type sources retain contract `1.0.0`. It is a contract gate: the full set must pass the production source parser, deterministic compiler and publication validator before Phase 2 begins.

These files are definition-source documents, not runtime API messages. Their readable snake-case aliases are local to this fixture set. The strict production schemas in [`@vortex/contracts`](../../contracts/README.md) validate the complete closed shape. The shipping [compiler](../../runtime/definition/src/compiler.ts) resolves each alias and version requirement only from the checked-in immutable snapshot, then the [publication validator](../../runtime/definition/src/validation.ts) proves cross-definition semantics before any runtime service may accept the result.

## Contents

| Path | Purpose |
|---|---|
| `fixture-set.json` | Complete manifest, required field types, workflow node catalogue, applications, and cross-application cases. |
| `definition-resolution-snapshot.json` | Contract `1.0.0` resolution envelope used by the current Application and connection-type sources. |
| `module-v2-definition-resolution-snapshot.json` | Contract `2.0.0` resolution envelope used by the current Module sources. It carries the same definitions and identities as the V1 envelope, with its own verified fingerprint. |
| `connection-types/` | Every connection type and operation referenced by either application. |
| `modules/` | Five CRM modules and three Service Desk modules, each independently versioned. |
| `applications/` | CRM and Service Desk definitions with exact module bindings, pages, roles, workflows, pipelines, connections, and interfaces. |
| `scenarios/` | Organisation data and expected outcomes for shared records, collaborative case access, and immediate revocation. |
| `storage/` | Complete record-type-to-table catalog, physical-name rules, application roots, scoped row examples, and collision tests. |
| `validate-fixtures.test.ts` | Shipping-code compilation plus manifest, scenario, storage, coverage, and policy proof. |
| `current-module-v2-runtime.test.ts` | In-memory-adapter proof using the shipping Definition publication and consumer-read services, followed by Record V2 value preparation against returned canonical record types. |
| `historical/module-v1/` | Immutable pre-migration Module V1 source and resolution evidence used only by historical read, restore, comparison, and conversion tests. |

## Required command

```text
pnpm fixtures
```

Success means every manifest file, source document, resolved identity, exact version, dependency, relationship, permission, action, event, page, query, workflow node, pipeline transition, connection operation, interface operation, and scenario reference resolves. It also proves complete provenance, all twenty-two field types, the complete safe workflow-node catalogue, a verified incoming-message acknowledgement, and qualified reverse-total relationships. The current-bundle runtime test publishes all eight Module V2 releases and both Application V1 releases through an in-memory repository adapter, reads them through the shipping consumer service, and prepares representative Company, Contact, and Case values from the returned canonical record types.

The two current resolution snapshots are separate immutable envelopes because Module V2 and Application V1 compilation requests accept different snapshot contract versions. Their definitions and identities are equal; each envelope retains and verifies its own fingerprint. Dependency releases likewise keep their own resolution evidence rather than being restamped with the consuming Application's fingerprint.

It also proves that every record type has one storage-contract table, every field has a stable physical column mapping, organisation-shared rows omit an application root, application-contained rows require one, and same-named CRM applications in separate organisations cannot collide.

The validator must never ignore an unresolved reference to accept an incomplete example. These tests do not claim a live database publication adapter, provisioned Record storage, or rendered application UI.

## Cross-application behaviour

- CRM and Service Desk bind the same CRM Organisations and CRM People module versions. Company and Contact records are organisation-wide records, not copies.
- Service Desk cases remain application-contained source records.
- CRM binds the Service Desk Cases definition only so it can understand records received through a grant; the binding itself grants no data access.
- The fixture grant exposes a limited set of case fields, permits changes only to status and priority, and permits only the published public-comment action.
- Revocation removes the case from CRM on the next access check and leaves no recipient record, summary record, search entry, offline value, or cross-request cached value.

## Explicit field permissions

The [field-access engine task](../../docs/build-plan/issue-37-field-access.md) adds
explicit authored field lists to the 94 record permissions. These are intentional
fixture definitions, not compiler defaults or rules inferred from application names.
Native read/export and form permissions enumerate the current fields they need;
form changes exclude generated reference numbers, calculations and totals. Named
actions declare only their own subject reads/changes. Content-free deletion,
restoration and sharing authority use empty lists. Adding a field later never
silently adds it to a permission.

Sensitive Contact notes are excluded from ordinary read/export/create/update.
The existing `view_sensitive_notes` identity is corrected from an unused named
action placeholder to an explicit read permission for `notes` only. This is an
intentional meaning change in these editable fixtures, not a rewrite of a stored
historical release. A future trusted read binding must explicitly include this
alternative and evaluate its own complete scope; Service Desk roles do not hold
it. No sensitive-notes write operation is invented.

The existing discount-approval permission declares read access to its amount,
discount and calculated result, with no change authority. It still lacks a real
named-action definition: [page/action bindings #250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250)
and [definition-first application proof #327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327)
must resolve that explicit fixture gap before claiming executable approval.
The same handoff covers the sensitive-notes alternative read binding.

The approved Case Summary grant is unchanged: six readable fields and changes to
status/priority only. Native Service Desk policies can include more fields, but
the source grant still restricts CRM. The fixture checks prove these declared
bounds and compilation, not live field enforcement or delivered screens.

## Physical storage rule

- The same validated record-type lineage uses one table across organisations and application bindings.
- `organisation_id` separates every organisation's records. `application_root_id` additionally separates application-contained records.
- A different or structurally forked record-type lineage uses a different table even when every visible name is identical.
- Table and field names come only from immutable storage tokens. Organisation, application, module, record-type, and field display names never become SQL identifiers.

## Change rule

Any fixture change must update its manifest and pass the validator in the same commit. A module or application version changes according to the compatibility rules in the [publication specification](../../docs/specification/03-composition-and-publication.md).
