# Typed table columns and permission-gated choices

Task: [#44](https://github.com/Abzum-NZ/Abzum-Vortex/issues/44).
Plan: [Record field values](../build-plan/issue-44-record-field-values.md).

## Delivered definition slice

Eight supported table-column types now carry their corresponding typed settings.
Actual default cells are validated in authored and canonical definitions. Choice
options can declare an optional permission reference, resolved through the current
module or a declared direct dependency to the exact permission identity. Nested
compiler provenance and permission-semantic major version impact are retained.
The editable application fixtures now describe their column options and currency.

This is configuration, not permission to save or disclose an option. Current
Access enforcement remains required in the later protected Record operations.
No application-specific behavior, database schema, UI, exact-value V2 runtime or
flow-binding correction is included.

## Actual-work review and verification

A different GPT-5.6 Sol agent independently reviewed the frozen eleven-file
implementation. One concrete issue was corrected: unconditional duplicate-key
validation narrowed previously accepted V1 settings-less tables. Those historical
definitions remain parseable and deterministic; semantic publication refuses
missing settings, while complete typed columns require unique keys. No compatibility
framework or new history state was introduced.

- Developer: 339 focused tests across four files, Contracts and Definition type
  checks, all 23 package boundaries, formatting and scoped diff checks passed.
- Independent reviewer: seven targeted new tests passed and all final frozen
  file hashes matched; approval issued with no remaining concrete finding.
- Root: all eleven reviewed hashes matched; scoped lint and formatting passed.
  The existing fixture-test lint ignore remained unchanged.

Source `b05b3646a23d1c9ecd646524cf3f15145b81ad4d` completed the normal
clean-source `pnpm verify` in
[preview FA98UEdYTDo9CFJMArbaGroypNcS](https://vercel.com/abzumdevteam/abzum-vortex/FA98UEdYTDo9CFJMArbaGroypNcS).
Root read the build logs: 104 test files / 1,433 tests passed; two files containing
three existing opt-in identity integration tests were skipped. The separate
complete-fixture run passed all 13 tests, and all 23 package builds succeeded.
The deployment became Ready after 5 minutes 30 seconds.

The normal Testing-base merge `ce681dddad207d9171514d23d99916cd908afc17` has an
identical Git tree. Its skipped-not-affected check was not used as substitute
evidence: root verified the original build's success first.
[PR #353](https://github.com/Abzum-NZ/Abzum-Vortex/pull/353) then merged normally
at `2026-09-08T09:16:46Z` as Testing
`0b9fe19c0e590dce1ac7ec4c5131918726a04563`.

## Reviewed prerequisites for the next slice

The existing Page rich-text grammar has been extracted without changing its
accepted content or public exports. Record values can reuse those primitives
without importing application composition or broadening what a Page accepts.
An exact-decimal primitive now parses, normalizes and compares decimal text
without converting it to floating-point numbers. It does not introduce arithmetic,
rounding, a global precision limit or a new dependency.

Both changes received independent actual-work approval from a different
GPT-5.6 Sol agent. Rich-text verification passed 56 focused tests; exact-decimal
verification passed 42 tests. Contracts type checks, all 23 package boundaries,
formatting and scoped lint passed. Root verified all five final reviewed file
hashes before staging. These are reusable prerequisites, not a claim that Module
V2 definitions can already be published or saved as records.

[PR #354](https://github.com/Abzum-NZ/Abzum-Vortex/pull/354) delivered these
prerequisites through the normal Testing merge at `2026-09-08T09:38:35Z`, producing
`0e9ab3a5696358c5ed5350e7b697cc6d10317e63`. The reviewed source
`534ffd5ece5ce1df25f79f5ce06ca36c80d359fc` received an actual completed successful
[preview deployment](https://vercel.com/abzumdevteam/abzum-vortex/2seewSygKS3KRCJEoFjduF3L18UY),
not a skipped-not-affected result. This does not claim that its subsequent hosted
database verification has completed.

## Reviewed Module V2 contracts

The explicit Module V2 source, canonical and field-value contracts cover all
twenty-two field types. They carry exact decimal values and bounds, amount-only
portable money defaults, resolved amount/currency record values, typed links,
ordered file references and Record rich-text values. Action inputs and saved
condition parameters can describe exact decimals and money without changing the
historical `number` parameter meaning.

Definition contracts now describe the corresponding source, draft, compilation,
consumer and version-impact evidence. These are standalone V2 contracts; the
operational aggregate selectors deliberately remain on the supported runtime
until compilation, publication, read and restore are implemented together.

A different GPT-5.6 Sol reviewer approved the actual ten-file implementation and
the four associated public exports. The reviewer caught a canonical money value
map that still accepted authored, non-normalized amounts; the owning map and its
regression coverage were corrected. The final review found no remaining issue.
Developer verification passed 166 focused owning-contract tests; independent
plumbing verification passed 31 tests. Root reran both new suites (19 tests),
Contracts type checking and all 23 package boundaries successfully. This is not
a claim of a working Record save or installable Module V2 runtime.

[PR #355](https://github.com/Abzum-NZ/Abzum-Vortex/pull/355) merged normally into
Testing at `2026-09-08T10:36:29Z`, producing
`b7d1b46812614d1e3ff11ffa1d5142e7931d5b00`. Reviewed contract source
`9c0918c3c9a1512158024985d495d72b1c1f10d8` received an actual successful
[preview build](https://vercel.com/abzumdevteam/abzum-vortex/FExdZDceDQbDiDJx1ydZuFDoW2L9)
with all 23 package builds successful. The normal Testing-base merge changed no
source bytes. Final PR head `9442cf58f8ebcf50a52ea4423151a20f00e1f744` additionally
carried the independently checked Rule-specification handoff and received its own
completed successful [preview deployment](https://vercel.com/abzumdevteam/abzum-vortex/H3zHJC5TctGZ7E6sxvNw9CqbiVWe).
No admin override or skipped-not-affected result substituted for these checks.
This records Testing merge evidence, not a new-revision hosted database receipt
or Production promotion.

## Reviewed exact-value condition engine

The Rule engine now evaluates conditions using the owning Module V2 field and
parameter types. Decimal comparisons retain exact precision; money comparisons
retain currency meaning. Text is not guessed to be numeric. Full-tree validation
still runs before evaluation, and the existing V1 evaluator retains its semantics.
Five ordinary semantic helpers are shared privately between the two adapters;
there is no second condition framework.

A different GPT-5.6 Sol reviewer approved the final five-file implementation.
The reviewer found and the author corrected one concrete mismatch: an
organization-account parameter must be a direct UUID, while a person-link field
retains its declared object shape. Developer, independent and root verification
each passed the 20 focused V1/V2 tests. Rule type checking and root scoped lint
passed, and root matched all five final reviewed SHA-256 hashes before staging.

This is the pure evaluation prerequisite for
[#44](https://github.com/Abzum-NZ/Abzum-Vortex/issues/44) and
[#57](https://github.com/Abzum-NZ/Abzum-Vortex/issues/57), not delivery of the
Conditions Designer, database evaluation parity or protected Record persistence.

[PR #356](https://github.com/Abzum-NZ/Abzum-Vortex/pull/356) merged normally into
Testing at `2026-09-08T11:04:45Z`, producing
`82fc2902445de45c0af3ecf6d82c13970fe429ff`. Reviewed source
`51f55c7cad4b5a7bc288123f374f66f81e714674` completed an actual successful
[preview build](https://vercel.com/abzumdevteam/abzum-vortex/HUnUQLNA9x38AVdW7ki9tUAJjPt6)
in 4 minutes 39 seconds; root read the successful 23-package build summary.
The normal Testing-base merge `bd12459dd9c40e7ecef4a8bbec0d7974f0311a65`
has the identical Git tree. Its skipped-not-affected check did not substitute for
the original source build. This is Testing merge evidence, not a new hosted
database completion receipt or Production promotion.

## Reviewed deliberate Module source conversion

The pure Module V1-to-V2 converter preserves the value already represented by a
finite old number while producing exact, non-exponent decimal text. Amount-only
money definition defaults remain portable. Known record-value literal contexts
retain explicit currency and reference targets; missing target/currency meaning
returns a source-path diagnostic rather than guessing. Formatted strings become
plain paragraph content. An external total-filter literal without its field type
also returns a diagnostic; conversion does not consult a mutable catalogue.

A different GPT-5.6 Sol reviewer approved the frozen implementation and tests,
with 13/13 focused tests and Definition type checking passing. Those tests include
conversion of all eight current editable Module fixtures without user choices and
verify no mutation of the input. This helper does not save or publish a draft;
the existing revision-checked draft save remains the only save path. Conversion
does not change published V1 bytes, dependency versions or historical semantics.
The current complete-fixture bundle still needs its coordinated V2 migration and
actual Definition execution proof before it is treated as delivered.

[PR #357](https://github.com/Abzum-NZ/Abzum-Vortex/pull/357) merged normally into
Testing at `2026-09-08T11:27:43Z`, producing
`990b6c3d1d4a116f9aa79becf0459fc1f848da98`. Root verified an actual completed
successful [source preview](https://vercel.com/abzumdevteam/abzum-vortex/4uxM9HU4BYwJHCWaqMb2cHej2RrD)
for `25ef0e655ee955a23638592924cad313d2872689` before merging. The final normal
Testing-base merge `acb8b00589f730c10393b06cc52d4c372be0fd2e` has the identical
Git tree; its skipped check was not substituted for that successful source build.
The one-line public export received its own independent approval. Unreviewed
Definition execution and Record preparation were excluded from this delivery.

## Reviewed Record value preparation

The Record service now supplies the pure `prepareRecordFieldValuesV2` operation
for canonical field-identifier maps. It returns a prepared set/clear patch or safe
field-located corrections. All nineteen writable field types are covered;
reference numbers, calculations and totals remain generated values that callers
cannot supply. Create defaults, update omission, required values, explicit clears,
exact decimal/money values, typed references and repeating-table cells retain
their declared meanings. Permission-gated choices and record/person/file
references produce explicit pending checks for the later protected operation;
preparation does not claim those checks succeeded.

A different GPT-5.6 Sol reviewer approved the actual five-file patch, including
the existing-catalogue Vitest development dependency and matching lockfile entry.
The reviewer caught a real repair defect: validation of an existing value ran
before its replacement or clear. The corrected merge validates the winning
submitted value, allowing a valid repair while still checking omitted existing
values. Independent post-fix verification passed all 34 focused tests. Developer
Record type checking, scoped lint/format and all package boundaries passed.

This reviewed pure slice is not a claim of integrated fixture publication,
protected persistence, current Access checks or complete #44 delivery. Those
remain in the coordinated Definition, storage and save work below.

[PR #358](https://github.com/Abzum-NZ/Abzum-Vortex/pull/358) merged normally into
Testing at `2026-09-08T11:57:12Z`, producing
`bd99cc93daecb09292663f147a09d075b15b792a`. Reviewed source
`62f4506d762074c0fb849986df0be8a9a65c6108` received an actual completed successful
[preview deployment](https://vercel.com/abzumdevteam/abzum-vortex/2ZaB8cVCTbnVEumPWtLA9kEDewdw).
Root reran the final 34 tests and Record type check and matched every reviewed
file hash before staging. The normal Testing-base merge
`30de4be65498e6dc2d429cbd8a27346915c70462` has the identical Git tree; its final
check was not used instead of the actual source preview. Unreviewed Definition
runtime and SQL changes were excluded. This is a Testing merge receipt, not a
hosted database completion or Production promotion claim.

## Reviewed Module V2 definition execution

The existing Definition engine now carries the explicit Module V2 source and
canonical contract pair through source identity resolution, compilation,
semantic validation, publication preparation/append, stored consumer readback,
history and restore. V1 remains a supported historical dialect; no value-shape
guessing changes the selected version. Exact field defaults/bounds, action and
condition literals, typed references, calculations/totals and sharing publication
tests use the appropriate declared V2 semantics. Version impact compares exact
decimal and money bounds without converting them to floating-point numbers.

An independent GPT-5.6 Sol reviewer approved the final nineteen-file implementation
against `bb5867d46c109c10e322bd82b58de78f5431c940`, matched all file hashes and ran
179 focused Module V2, repository and version-impact tests successfully, plus
Definition type checking. Review corrections address shared type dispatch and
normalization at their owning paths, including derived-field publication values,
reference targets, collection elements and distinct opaque action-value shapes.
They do not add a second validator or condition engine.

Developer verification passed all 358 Definition tests with a ten-second test
ceiling, 132 focused Contracts tests, both package type checks, scoped lint and
format checks, and all 23 package boundaries. One earlier five-second timeout
during concurrent checking passed in isolation; the final full suite passed.

The end-to-end service tests use in-memory publication/history adapters; separate
repository tests exercise serialization and materialization. These results do
not prove live database predicate parity, activated record storage, migration of
the complete editable fixture bundle, or a rendered application. Those remain
explicit follow-on work.

[PR #359](https://github.com/Abzum-NZ/Abzum-Vortex/pull/359) merged normally into
Testing at `2026-09-08T12:41:03Z`, producing
`1b4ab301238fdc755f7c1ac070346e5512820408`. Root confirmed the actual completed
successful [source preview](https://vercel.com/abzumdevteam/abzum-vortex/2z1ywbhojcu5NKTEYE5XEfaPm3Q9)
for `6b7a973f342fe6bd52b6f99050c757901263d404` before merging. The normal Testing-base
merge `f7527bc09304b58b671ab7ea196ed441c51ee90f` has the identical Git tree
`9800d9cff1cbbedb32e239810ced5618d2d7bd58`; its final success did not substitute for
the original source build. Unreviewed storage, permission-catalogue and #35/#250
work was not included. This is a Testing merge receipt, not hosted database
verification or Production promotion.

## Remaining integrated work

The whole #44 task stays open. The current complete editable fixture bundle still
needs its coordinated V2 migration and compiled Record-value proof; database
predicate parity and real protected save/readback are not delivered by these
pure/Definition slices. The new Testing revision's hosted database execution has not
yet been verified here; an older successful receipt is not a new-revision claim.
The [new Testing execution](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/6asr83WskOIDv67Xx4LCCr)
is running. Its logs confirm exact revision
`0b9fe19c0e590dce1ac7ec4c5131918726a04563` and migration-set hash
`f3e6f03a936fc32f27b37c9858bbcf19e013d9edc3ed5b6d8253a8cd0309130b`.
This is revision-matching progress evidence, not a successful completion receipt.
Production is unchanged by this record.
