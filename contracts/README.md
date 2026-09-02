# Vortex contract index

[Platform specification](../docs/specification/README.md) · [Data-contract appendix](../docs/specification/appendices/data-contracts.md) · [Phase 1 build plan](../docs/build-plan/README.md#phase-1--contracts-and-complete-fixtures) · [Validation-error author guide](VALIDATION_ERRORS.md)

This package is the database-free canonical language shared by the Vortex services. It accepts complete definitions with platform-issued identifiers and contains no installed definition names or behaviour. The readable snake-case JSON under `testing/fixtures` is non-shipping compiler input used to prove the dependency set; [issue #15](https://github.com/Abzum-NZ/Abzum-Vortex/issues/15) owns the complete production authored-source boundary and deterministic conversion into these canonical contracts.

Every schema rejects unknown properties. A schema file can depend only on this package's lower-level files and Zod; it cannot import browser, server, database, Supabase, Kestra, or service code.

| Export group | Layer | Governing specification | Source |
|---|---|---|---|
| Identifiers, definition envelopes, references, storage and lineage | Canonical runtime | [Identifiers and published definitions](../docs/specification/appendices/data-contracts.md#identifier-rules) | `identifiers.ts`, `definitions.ts`, `records.ts`, `storage.ts`, `lineage.ts` |
| Closed catalogues and common values | Canonical runtime | [Field contracts](../docs/specification/appendices/data-contracts.md#field-contract), [applications](../docs/specification/07-applications-pages-and-themes.md), [workflows](../docs/specification/09-workflows-and-pipelines.md) | `catalogues.ts`, `common.ts` |
| Tenants, identities, organisation accounts, runtime settings, roles, sharing and protected grant consent | Canonical runtime | [People and organisations](../docs/specification/02-people-organisations-and-sign-in.md), [access](../docs/specification/04-access-and-permissions.md) | `identity-access.ts` |
| Modules, record types, all 22 fields, relationships, actions, rules and events | Canonical runtime | [Modules, fields and relationships](../docs/specification/05-modules-fields-and-relationships.md), [forms and actions](../docs/specification/08-forms-actions-rules-and-events.md) | `module-contracts.ts` |
| Applications, queries, all six pages, blocks, roles, themes and pipelines | Canonical runtime | [Applications, pages and themes](../docs/specification/07-applications-pages-and-themes.md), [queries](../docs/specification/10-queries-reports-search.md) | `application-contracts.ts` |
| The 24 generic workflow nodes, triggers, engine-neutral executions and protected operations | Canonical runtime | [Workflows and pipelines](../docs/specification/09-workflows-and-pipelines.md) | `automation-contracts.ts` |
| Connections, interfaces and federation | Canonical runtime | [Connections and interfaces](../docs/specification/12-connections-and-interfaces.md), [federation](../docs/specification/17-runtime-storage-and-caching.md#vortex-federation-between-clusters) | `integration-contracts.ts` |
| Records, events, invalidations, files, retention, protected removal, entitlements, metering, safe errors and measurements | Canonical runtime | [Data-contract appendix](../docs/specification/appendices/data-contracts.md) | `operation-contracts.ts` |
| Safe definition-validation result, catalogue, rule handoff and translators | Canonical runtime | [Definition validation errors](../docs/specification/appendices/data-contracts.md#definition-validation-errors) | `validation-errors.ts` |
`contract-index.ts` exports the same grouping for tooling. `index.ts` is the only package entry point.

## Proof

`pnpm test` checks every catalogue member, strict union, identity/account boundary, grant invariant, secret reference, safe error and the strict test-only fixture input shapes. `pnpm fixtures` independently validates the non-shipping scenario and storage evidence, resolves the complete dependency graph and checks all cross-document references. Both commands are included in `pnpm verify`.
