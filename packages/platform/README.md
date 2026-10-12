# Vortex platform

[Platform specification](../../docs/specification/README.md) | [Data-contract appendix](../../docs/specification/appendices/data-contracts.md) | [Build plan](../../docs/build-plan/README.md#phases) | [Definition validation error guide](VALIDATION_ERRORS.md)

`@vortex/platform` contains the platform's shared contracts and server operations. Its public entry points are `@vortex/platform/schema` for browser-safe schemas, types and pure helpers, and `@vortex/platform/server` for database-backed operations. The server entry point imports `server-only`; schema modules do not import server implementations.

## Public entry points

| Entry point | Source | Contents |
|---|---|---|
| `@vortex/platform/schema` | `src/schema.ts` | Zod schemas, inferred types and pure helpers for definitions, pages, files, themes, connections, catalogues, workflows, access, rules, queries, identity, records and events. It also exports the event client, component result-state helpers and flow interpreter. |
| `@vortex/platform/server` | `src/server.ts` | Database transactions and server operations for identity, access, definitions, connections, records, queries, pages, rules, workflows, files, events, search and themes. |

The source folders group implementation by domain:

- `access` and `identity`: request context, sign-in and identity lifecycle, organisation access, roles, permissions and access operations.
- `catalogue`: shared catalogue schemas, identifiers, runtime primitives and definition-validation errors.
- `connections`: connection configuration, readiness and outbound-target policy.
- `db`: request database lifetime and transaction helpers.
- `definition`: authored contracts, compilation, validation, publication, installation and runtime definition reads.
- `events` and `search`: event delivery and invalidation, search indexing, matching and access filtering.
- `files`: file metadata, upload and read operations, storage policy, attachments and structured record import.
- `pages`, `queries` and `records`: page runtime capabilities, protected query operations, and record changes, sharing and lifecycle.
- `rules` and `workflows`: typed conditions and flow interpretation, plus durable workflow starts and Kestra integration.
- `theme`: theme selection, resolution and validation.

These folders describe source ownership; the package entry points above define what consumers can import. A schema parse establishes that data matches its contract. It does not authenticate a caller, decide permissions, read protected current state, commit a transaction or perform an operation.

Definition validation errors are maintained in the catalogue contract and translated into a safe public result. See [the validation error guide](VALIDATION_ERRORS.md) for the error codes and translation rules.
