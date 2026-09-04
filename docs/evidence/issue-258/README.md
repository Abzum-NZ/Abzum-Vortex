# Issue 258 — literal data and declared references

[Task](https://github.com/Abzum-NZ/Abzum-Vortex/issues/258) · [Page contracts](../../specification/appendices/page-builder-contracts.md#literal-data-is-not-a-reference)

## Scope

This correction changes definition validation, compilation dependency collection and version comparison only. It adds no UI, workflow executor, database migration, provider integration or business-domain behavior. It was built in an isolated checkout; the original checkout and the other agent's request-context implementation were not edited or code-reviewed.

The initial implementation commit is [13d655e](https://github.com/Abzum-NZ/Abzum-Vortex/commit/13d655e693e8cfed9e1fb4850ee92452ca95c0d6). The integration base is Testing [ae88ed5](https://github.com/Abzum-NZ/Abzum-Vortex/commit/ae88ed552ad715061cc9f5b8cc710c1e18fb0778). The follow-up commit adds the record-map-key regression and correction.

## What changed

- A schema-directed walker distinguishes declared reference positions from opaque JSON.
- Publication contracts and version comparison share the same record-type-reference check.
- Semantic checks use per-call schema positions: literals cannot invent field references, workflow producers or local definition identities.
- Calculation dependency collection ignores reference-shaped condition data.
- User-defined input-map keys such as `fieldId` are not declared platform reference properties.
- Literal contents remain unchanged in source, compilation, fingerprints, version comparison and stored-release evidence. Genuine unresolved or malformed references are still refused.
- Current scalar page controls still enforce their own types. Richer object/array controls belong to [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), not this bug fix.

## Regression coverage

| Proof | Test |
|---|---|
| Literal and nested-array preservation; exact genuine-reference refusal path; malformed kinds | [Contract regressions](../../../contracts/test/reference-traversal.test.ts) |
| Action and workflow values, condition operands, record-map labels, isolated traversal state | [Semantic traversal regressions](../../../runtime/definition/test/contract-value-walker.test.ts) |
| Authored compilation and publication validation with reference-shaped workflow literals and repeated data keys | [Compiler tests](../../../runtime/definition/test/compiler.test.ts) |
| Page publication-contract round trip, literal change fingerprint and real-reference refusal | [Version-impact tests](../../../runtime/definition/test/version-impact.test.ts) |
| Stored-release reading through the service with serialized immutable evidence | [Consumer-read tests](../../../runtime/definition/test/definition-consumer-read.test.ts) |

The map-key regression was observed failing before its fix. Existing example fixtures are used only as test data; synthetic payloads and the implementation contain no domain-specific exception.

## Verification and limits

The final database-free `pnpm verify` passed after integrating Testing and including the record-map-key regression and correction: formatting, lint, all 23 package type checks, boundaries, 646 tests passed with three existing skips, the eight fixture tests and all 23 builds including Next.js.

No database was reset and no hosted database test was run. Storage coverage uses the existing service/repository test doubles and serialized evidence, not a claim of a new hosted publication exercise. There is no new visual output to screenshot. The diff was reviewed locally; no independent subagent review is claimed.
