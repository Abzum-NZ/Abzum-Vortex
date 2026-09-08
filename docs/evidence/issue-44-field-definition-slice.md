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

## Remaining work

The whole #44 task stays open. The coordinated exact-value Module V2 pipeline,
Record preparation and real protected save/readback are not delivered by this
definition slice. Its new Testing revision's hosted database execution has not
yet been verified here; an older successful receipt is not a new-revision claim.
Production is unchanged by this record.
