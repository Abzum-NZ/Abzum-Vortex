# Definition validation errors

[Platform package guide](README.md) | [Data-contract specification](../../docs/specification/appendices/data-contracts.md#definition-validation-errors)

`src/catalogue/validation-errors.ts` defines the public validation result, the versioned error
catalogue and the one rule-failure translator. The current catalogue version is `1.4.0`. Supported
document kinds are `module`, `application` and `connection_type`.

## Public result

A result carries the catalogue version, a correlation identifier and one or more errors. Each error
has a stable code, catalogue-owned message and guidance, the same correlation identifier, and an
optional safe location. A location contains a document kind and key with up to 12 segments. The
public schemas reject unknown properties.

The public error codes are the catalogue's own codes plus the Records table feature refusal codes.
The catalogue's own codes include `definition_required_value`, `definition_invalid_value`,
`definition_unsupported_choice`, `definition_unknown_property`, `definition_too_few_items`,
`definition_too_many_items`, `definition_duplicate_key`, `definition_broken_reference`,
`definition_unresolved_reference`, `definition_scope_conflict`, `definition_incompatible_version`,
`definition_dependency_cycle`, `definition_unsafe_content`, `definition_incompatible_change`,
`definition_more_errors` and `definition_validation_failed`, beside the query-binding, Records table
and form rules each named in the catalogue. `definitionValidationErrorCodes` in that file is the one
list.

Messages and guidance come from the catalogue; callers do not supply public text. The result contains
no submitted values, schema messages, raw object paths or protected diagnostics.

## Translating failures

`translateDefinitionRuleFailures` accepts rule failures containing a namespaced rule code, a closed
failure family and an optional safe location. The translator maps each family to its public error
code and uses the root location when a rule failure has no location.

The translator removes duplicate errors at the same location, orders the result by location and
catalogue order, and caps it at 200 errors. When errors are omitted, the final entry uses
`definition_more_errors`. An empty or malformed translation result becomes
`definition_validation_failed` when a valid correlation identifier is available; a missing or
invalid correlation identifier is rejected.

An optional diagnostic sink receives the original rule detail separately from the public result. A
sink failure does not change translation. Keep diagnostic handling protected; never copy its detail
into a builder-visible error.

## Updating the catalogue

When adding or changing a public code, keep the code list, catalogue entry, message, guidance and
ordering together in `src/catalogue/validation-errors.ts`. Add or update a closed rule-failure family
and its mapping when rule validation needs to emit the code. Keep public messages generic and rely on
safe locations to direct an authorised builder to the relevant part of a definition.

Translation is implemented with the shared schemas and pure helpers. It does not authenticate the
caller, grant access or perform a database operation; those decisions belong to the protected caller
and storage path.
