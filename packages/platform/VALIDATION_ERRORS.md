# Definition validation errors

[Platform package guide](README.md) | [Data-contract specification](../../docs/specification/appendices/data-contracts.md#definition-validation-errors)

`src/catalogue/validation-errors.ts` defines the public validation result, the versioned error catalogue and the translators for schema and rule failures. The current catalogue version is `1.1.0`. Supported document kinds are `module`, `application` and `connection_type`.

## Public result

A result carries the catalogue version, a correlation identifier and one or more errors. Each error has a stable code, catalogue-owned message and guidance, the same correlation identifier, and an optional safe location. A location contains a document kind and key with up to 12 segments. The public schemas reject unknown properties.

The public error codes are:

- `definition_required_value`, `definition_invalid_value`, `definition_unsupported_choice`, `definition_unknown_property`
- `definition_too_few_items`, `definition_too_many_items`, `definition_duplicate_key`
- `definition_broken_reference`, `definition_unresolved_reference`, `definition_scope_conflict`, `definition_incompatible_version`, `definition_dependency_cycle`
- `definition_unsafe_content`, `definition_incompatible_change`
- `definition_more_errors`, `definition_validation_failed`

Messages and guidance come from the catalogue; callers do not supply public text. The result contains no submitted values, schema messages, raw object paths or protected diagnostics.

## Translating failures

`translateDefinitionSchemaError` maps Zod issues to the closed public codes. Supply a correlation identifier, safe root location, and explicit raw-path-to-safe-location mappings. An unmapped path resolves to the root location. When a strict schema uses the same `invalid_type` issue for a missing and a wrong-typed value, list known missing source paths in `requiredPaths` so the translator can use `definition_required_value` for those paths.

`translateDefinitionRuleFailures` accepts rule failures containing a namespaced rule code, a closed failure family and an optional safe location. The translator maps each family to its public error code and uses the root location when a rule failure has no location.

Both translators remove duplicate errors at the same location, order the result by location and catalogue order, and cap it at 200 errors. When errors are omitted, the final entry uses `definition_more_errors`. An empty or malformed translation result becomes `definition_validation_failed` when a valid correlation identifier is available; a missing or invalid correlation identifier is rejected.

An optional diagnostic sink receives the original schema or rule detail separately from the public result. A sink failure does not change translation. Keep diagnostic handling protected; never copy its detail into a builder-visible error.

## Updating the catalogue

When adding or changing a public code, keep the code list, catalogue entry, message, guidance and ordering together in `src/catalogue/validation-errors.ts`. Add or update a closed rule-failure family and its mapping when rule validation needs to emit the code. Keep public messages generic and rely on safe locations to direct an authorised builder to the relevant part of a definition.

Translation is implemented with the shared schemas and pure helpers. It does not authenticate the caller, grant access or perform a database operation; those decisions belong to the protected caller and storage path.
