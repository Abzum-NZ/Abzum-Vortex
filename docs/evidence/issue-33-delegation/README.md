# Issue 33 C3f delegation management evidence

## Delivered boundary

C3f adds three owner-only delegation operations: grant a delegation, replace
its complete scope, and terminally revoke it. The coordinator remains
`SECURITY INVOKER`, has an empty search path, and is not executable by public
or runtime request roles. A later protected-operation boundary remains
responsible for authorizing callers.

A bounded scope is one closed, canonically ordered array of exact permission
tuples. The coordinator validates the proposed replacement against current
catalogue and continuity evidence, but it does not revalidate stale stored
scope during replacement or revocation. The scope fingerprint is provenance
for the canonical preparation; it is not an additional authority dimension.
Consequently, identical scope kind and exact tuples are an unchanged scope
even if a caller presents different fingerprint evidence.

The focused SQL proof uses the real coordinated application registration and
withdrawal writer to make application permission continuity stale. It proves
that stale stored authority can be replaced or revoked while a proposed stale
scope is refused. It also covers account and Group holders, foreign and
inactive holders, fixed windows, terminal revocation, duplicate identities,
whole-scope replacement, dedicated Access-version evidence, and atomic
delegation-revision and Access-version exhaustion.

## Verification

Independent review confirmed that the private SQL interface and complete JSON
result match the prepared contract and test-only handoff. Review also required
the focused foreign-Group and exhaustion cases and verified that fingerprint
evidence cannot become a second authority identity.

The final Local database gate passed:

- 33 SQL test files with 1,634 assertions;
- all 16 manifest-listed concurrency proofs, including the delegation proof;
- SQL lint across all five schemas.

The repository gate passed 1,101 tests with three existing skips across 74 test
files with two skipped files, all eight fixtures, and all 23 package
typechecks, builds, and boundary checks. Typecheck and build reused the valid
shared cache; an earlier agent run had already completed the uncached build.

All database fixtures and probes were transaction-scoped or ownership-scoped.
This evidence makes no hosted-environment or user-interface claim.

## Frozen artifacts

- `20260906013637_add_delegation_changed_access_reason.sql`:
  `f563aa3ac2f85bb767a5ba7fc51f802c6b78cc74872db81e80416d30926e62ba`
- `20260906013706_coordinate_organization_delegation_authority_changes.sql`:
  `089bde08c2d5db79011e0608100dac9105e4ab5668f07cd602d8e9391e698265`
- `250_organization_delegation_authority_changes.test.sql`:
  `8f0075930d07f7549bf0724ab3a6b3ed468489983ccd0b650d6d6f4834fc756a`
- `organization-delegation-authority-change-concurrency.test.sh`:
  `21bed40b729fba33f54622d799f2c7799c21bcb5f921c582285eaa6249e025d5`
- `workflows/kestra/database-verification.json`:
  `4f529b9dad6e1cb8f110b6cf623fea5985f3bde4a3101cdbe46e7faeb7248572`
