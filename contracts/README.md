# Vortex contract index

[Platform specification](../docs/specification/README.md) · [Data-contract appendix](../docs/specification/appendices/data-contracts.md) · [Phase 1 build plan](../docs/build-plan/README.md#phase-1--contracts-and-complete-fixtures) · [Validation-error author guide](VALIDATION_ERRORS.md)

This package is the database-free language shared by the Vortex services. Runtime services accept the canonical camel-case contracts with platform-issued identifiers. Example JSON definitions use a separate, strict snake-case source layer; [issue #15](https://github.com/Abzum-NZ/Abzum-Vortex/issues/15) owns resolving readable local aliases to canonical identifiers before publication. Runtime contracts and validators never contain installed definition names or behaviour.

Every schema rejects unknown properties. A schema file can depend only on this package's lower-level files and Zod; it cannot import browser, server, database, Supabase, Kestra, or service code.

| Export group | Layer | Governing specification | Source |
|---|---|---|---|
| Identifiers, definition envelopes, references, storage and lineage | Canonical runtime | [Identifiers and published definitions](../docs/specification/appendices/data-contracts.md#identifier-rules) | `identifiers.ts`, `definitions.ts`, `records.ts`, `storage.ts`, `lineage.ts` |
| Closed catalogues and common values | Canonical runtime | [Field contracts](../docs/specification/appendices/data-contracts.md#field-contract), [applications](../docs/specification/07-applications-pages-and-themes.md), [workflows](../docs/specification/09-workflows-and-pipelines.md) | `catalogues.ts`, `common.ts` |
| Tenants, identities, organisation accounts, profiles, roles, sharing and approvals | Canonical runtime | [People and organisations](../docs/specification/02-people-organisations-and-sign-in.md), [access](../docs/specification/04-access-and-permissions.md) | `identity-access.ts` |
| Modules, record types, all 22 fields, relationships, actions, rules and events | Canonical runtime | [Modules, fields and relationships](../docs/specification/05-modules-fields-and-relationships.md), [forms and actions](../docs/specification/08-forms-actions-rules-and-events.md) | `module-contracts.ts` |
| Applications, queries, all six pages, blocks, roles, themes, motion and pipelines | Canonical runtime | [Applications, pages and themes](../docs/specification/07-applications-pages-and-themes.md), [queries](../docs/specification/10-queries-reports-search.md) | `application-contracts.ts` |
| All 33 workflow nodes, triggers, executions and protected operations | Canonical runtime | [Workflows and pipelines](../docs/specification/09-workflows-and-pipelines.md) | `automation-contracts.ts` |
| Connections, interfaces and federation | Canonical runtime | [Connections and interfaces](../docs/specification/12-connections-and-interfaces.md), [federation](../docs/specification/17-runtime-storage-and-caching.md#vortex-federation-between-clusters) | `integration-contracts.ts` |
| Records, events, invalidations, files, retention, privacy, billing, announcements, errors and measurements | Canonical runtime | [Data-contract appendix](../docs/specification/appendices/data-contracts.md) | `operation-contracts.ts` |
| Safe definition-validation result, catalogue, rule handoff and translators | Canonical runtime | [Definition validation errors](../docs/specification/appendices/data-contracts.md#definition-validation-errors) | `validation-errors.ts` |
| Application, module, connection, sharing-scenario and storage-layout JSON examples | Definition source | [Worked examples](../docs/specification/appendices/worked-examples.md#required-fixture-set) | `fixture-contracts.ts` |

`contract-index.ts` exports the same grouping for tooling. `index.ts` is the only package entry point.

## Proof

`pnpm test` checks every catalogue member, strict union, identity/account boundary, grant invariant, secret reference, motion contract, and every manifest-listed source fixture. `pnpm fixtures` independently resolves the complete dependency graph and all cross-document references. Both commands are included in `pnpm verify`.
