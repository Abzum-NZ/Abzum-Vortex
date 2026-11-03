# Vortex platform

[Platform specification](../../docs/specification/README.md) | [Data-contract appendix](../../docs/specification/appendices/data-contracts.md) | [Target architecture](../../docs/architecture/target-architecture.md) | [Definition validation error guide](VALIDATION_ERRORS.md)

`@vortex/platform` contains the platform's shared contracts and server operations. It has two public entry points:

- `@vortex/platform/schema` (`src/schema.ts`): browser-safe Zod schemas, inferred types and pure helpers.
- `@vortex/platform/server` (`src/server.ts`): database-backed operations. It imports `server-only`; schema modules never import server implementations.

Source is grouped by domain under `src/` (see the [domain module shape](../../docs/architecture/target-architecture.md#domain-module-shape)). The checked-in shadcn catalogue data under `src/catalogue/catalogue/` is maintained as platform data, not generated at build time. Theme and font release data stays behind the server entry; `shadcn-font-options.json` is the small browser-safe font view used by the renderer.

A schema parse establishes that data matches its contract. It does not authenticate a caller, decide permissions, read protected current state, commit a transaction or perform an operation.
