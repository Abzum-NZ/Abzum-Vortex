# Shared component and flow-node binding contracts

Task: [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250).
Specification: [Frontend flows](../specification/appendices/frontend-rule-designer.md).
Sequence: [engines before designer](engine-first-application-delivery.md).

## First bounded deliverable

Define the shared configuration language that component events and flow nodes
will use. This slice does not execute a flow or make new application definitions
publishable. It consumes existing generic references, values and identity
contracts; reuse them rather than add a competing type or operation catalogue.

1. Describe stable component/control identity and semantic events. Configurable
   action and data-provider events target an exact application-owned or
   platform-managed Frontend Flow, never a direct page-side query or mutation.
2. Describe typed inputs and result maps with explicit page-subject, related-record,
   row/selection and form context. A related panel need not share the page subject's
   record type. Trusted current-account values are server-resolved sources, not
   client-provided actor or permission claims.
3. Describe protected operations for flow nodes using exact owner/operation
   references, typed inputs/outputs, permission references, revision requirements,
   confirmation/duplicate semantics and safe result kinds. Include query,
   form-continuation and durable-start references without adding their executors.
   Do not accept callbacks, raw queries, RPC URLs or arbitrary executable code.
4. Describe Current user and protected Specified-user/System binding references.
   These neither issue authority nor accept caller-authored trusted contexts.
   Current user remains the original initiator, not the preceding node's override.
5. Describe effects and committed/partial/uncertain/background-pending outcomes.
   A configured load/refresh flow may contain writes. Rendering, prefetching,
   cache reads and transport retries do not themselves invoke an effectful flow.
6. Export the strict, explicitly versioned reusable contracts and register their
   ownership in the existing contract index. Do not add a registry service,
   database table, counter or framework.

## Exact boundary and compatibility

Expected files: one operation-specific Contracts source module, its public export
and existing contract-index entry, plus one focused test file. Reuse existing
value/reference schemas wherever they express the required meaning.

Current Application V1/V2 source/canonical/compiler/store selectors remain
unchanged. Existing V2 query metadata is not silently turned into a flow. A
standalone descriptor passing validation does not prove its referenced flow,
query, managed dependency or executor exists. Existing Page controls remain
unavailable when their actual operation binding is absent.

Later coordinated binding/graph integration must resolve real definition
dependencies across compilation, publication/readback, history and restore,
preserving old immutable bytes and fingerprints. Choose the smallest compatible
explicit representation change with that actual integration; do not introduce a
new Application version or compatibility framework in this descriptor-only slice.
Unknown/missing definitions cannot become a successfully published fallback.

## Acceptance

- A neutral fixture covers action and data events, page and related/row context,
  typed form inputs/results, query/durable-start node targets and run-as references.
- Component events accept flow targets only; operations appear only as node targets.
- Invalid kinds, unknown fields, wrong value shapes and caller-supplied trusted
  actor/permission evidence refuse. Exact reference resolution remains an owning
  compiler responsibility, not a false claim made by structural parsing.
- A configured load/refresh can describe changing work. Pure rendering/cache
  activity is not an authored invocation trigger.
- Existing source/canonical readers and fingerprints stay unchanged. Contracts
  tests, types and package boundaries pass; independent actual-work review follows
  the [coordination rules](agent-coordination.md).
- No renderer, executor, database migration, form-draft store, App Designer or
  hosted business effect is introduced. Whole #250 remains open for integration.

## Downstream ownership

[Query #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54),
[execution identity #322](https://github.com/Abzum-NZ/Abzum-Vortex/issues/322)
and [Frontend Flow #58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58)
consume this shared language without creating reverse dependencies on their
executors. [Registered rendering #66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66)
can use descriptors without implementing hidden data/action handlers. Complete
browser use still requires the actual engines and installation path; the Puck
adapter and App Designer do not block this foundation.
