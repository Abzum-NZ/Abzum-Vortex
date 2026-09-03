# Vortex contract index

[Platform specification](../docs/specification/README.md) · [Data-contract appendix](../docs/specification/appendices/data-contracts.md) · [Phase 1 build plan](../docs/build-plan/README.md#phase-1--contracts-and-complete-fixtures) · [Validation-error author guide](VALIDATION_ERRORS.md)

This package is the database-free definition language shared by the Vortex services. It exports both the strict, readable authored-source boundary and the complete canonical runtime contracts with platform-issued identifiers. Neither layer contains installed definition names or behaviour. The snake-case JSON under `testing/fixtures` is non-shipping input that proves the production parser and compiler against a dependency-complete example set.

Every schema rejects unknown properties. A schema file can depend only on this package's lower-level files and Zod; it cannot import browser, server, database, Supabase, Kestra, or service code.

| Export group | Layer | Governing specification | Source |
|---|---|---|---|
| Identifiers, definition envelopes, references, storage and lineage | Canonical runtime | [Identifiers and published definitions](../docs/specification/appendices/data-contracts.md#identifier-rules) | `identifiers.ts`, `definitions.ts`, `records.ts`, `storage.ts`, `lineage.ts` |
| Closed catalogues and common values | Canonical runtime | [Field contracts](../docs/specification/appendices/data-contracts.md#field-contract), [applications](../docs/specification/07-applications-pages-and-themes.md), [workflows](../docs/specification/09-workflows-and-pipelines.md) | `catalogues.ts`, `common.ts` |
| Tenants, identities, organisation accounts, runtime settings, live permissions/roles, sharing and protected grant consent | Canonical runtime | [People and organisations](../docs/specification/02-people-organisations-and-sign-in.md), [access](../docs/specification/04-access-and-permissions.md) | `identity-access.ts` |
| Definition-owned permission declarations | Canonical runtime | [Access and permissions](../docs/specification/04-access-and-permissions.md) | `permissions.ts` |
| Modules, record types, all 22 fields, relationships, saved sharing conditions, actions, rules and events | Canonical runtime | [Modules, fields and relationships](../docs/specification/05-modules-fields-and-relationships.md), [forms and actions](../docs/specification/08-forms-actions-rules-and-events.md) | `module-contracts.ts` |
| Applications, queries, all six pages, blocks, roles, themes and pipelines | Canonical runtime | [Applications, pages and themes](../docs/specification/07-applications-pages-and-themes.md), [queries](../docs/specification/10-queries-reports-search.md) | `application-contracts.ts` |
| The 24 generic workflow nodes, triggers, engine-neutral executions and protected operations | Canonical runtime | [Workflows and pipelines](../docs/specification/09-workflows-and-pipelines.md) | `automation-contracts.ts` |
| Connections, interfaces and federation | Canonical runtime | [Connections and interfaces](../docs/specification/12-connections-and-interfaces.md), [federation](../docs/specification/17-runtime-storage-and-caching.md#vortex-federation-between-clusters) | `integration-contracts.ts` |
| Records, events, invalidations, files, retention, protected removal, entitlements, metering, safe errors and measurements | Canonical runtime | [Data-contract appendix](../docs/specification/appendices/data-contracts.md) | `operation-contracts.ts` |
| Safe definition-validation result, catalogue, rule handoff and translators | Canonical runtime | [Definition validation errors](../docs/specification/appendices/data-contracts.md#definition-validation-errors) | `validation-errors.ts` |
| Definition version-impact requests, results, closed reasons and confirmation | Canonical runtime | [Version-impact policy](../docs/specification/appendices/version-impact-policy.md) | `version-impact.ts` |
| Module, application and platform connection-type authored documents | Authored source | [Source and runtime layers](../docs/specification/appendices/data-contracts.md#runtime-and-definition-source-layers) | `definition-source.ts`, `definition-source-common.ts`, `module-source-contracts.ts`, `application-source-contracts.ts`, `connection-source-contracts.ts` |
| Immutable resolution input, compilation output, provenance and install/runtime handoffs | Compilation boundary | [Compilation and validation](../docs/specification/03-composition-and-publication.md#authored-definition-compilation) | `definition-compilation-contracts.ts` |
`contract-index.ts` exports the same grouping for tooling. `index.ts` is the only package entry point.

## Proof

`pnpm test` checks every catalogue member, strict union, source document, identity/account boundary, grant invariant, secret reference, safe error and compilation handoff. `pnpm fixtures` parses and compiles all thirteen definition documents through shipping code, validates their complete dependency graph, and separately proves non-shipping scenarios and storage evidence. Both commands are included in `pnpm verify`.
