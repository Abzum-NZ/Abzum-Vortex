# Application role review volume

Publication compiles every role's resolved permissions, including permissions supplied by Modules
and application wildcards. It refuses a version whose role review allowance exceeds 917,504 bytes
(896 KiB). The refusal explains that the author must use fewer roles, permissions or field-level
grants before publishing. Drafts remain editable. No permission or review entry is truncated.

The allowance is a conservative storage budget, not the length of the visible text:

- Each role contributes 512 bytes plus the UTF-8 length of its name and key. This covers its saved
  identity and flags, organisation label, holder count, explanatory wording and submitted ID.
- Each granted permission contributes the JSONB storage upper bound of its key/label object, the
  UTF-8 length of its displayed label, and 16 bytes for change markers and separators. The saved
  first-install `expected.roles` snapshot and displayed labels are both charged.
- Each readable or changeable field grant contributes another 384 bytes. A change entry can contain
  two 60-character labels (record type and field), each using up to 180 UTF-8 bytes, plus its change
  marker, edit suffix and separator. This bound also covers UUID fallbacks and renamed fields.

An upgrade may combine roles accepted from different releases. Publication therefore checks two
independent allowances on every version:

- The sum of this version's roles is at most 917,504 bytes (896 KiB).
- 500 times this version's largest role is at most 99,483,648 bytes. This limits every published
  role to at most 198,967 bytes, regardless of how many other roles that version contains.

The old side can contain at most 500 roles, each retaining a subset of a permission set accepted
from some published version. Its upper bound is therefore 99,483,648 bytes even when all 500
roles retain meanings from different releases. Adding the selected version's 917,504 bytes and
262,144 bytes for flow state, release identities, bindings, release notes and reviewed role revisions
gives exactly 100,663,296 bytes (96 MiB), the database continuation capacity. The 500-role count
ceiling is shared with confirmation entries. Both publication allowances must pass.

For the review's counterexample, a large role with two 216-byte grants, four-byte name/key and
1,000 field grants costs `512 + 4 + 4 + 2 * 216 + 384 * 1,000 = 384,952` bytes. A release with
only two such roles can pass the per-version allowance, but `500 * 384,952 = 192,476,000` exceeds
the historical allowance and publication now refuses it. Eighteen older large roles would otherwise
produce at least 2,346,678 bytes of field-removal text, exceeding the former 2 MiB continuation.
That sequence can no longer be published. Every accepted role's independently retained permission
set is bounded before publication, including resolved Module permissions and wildcards.

The publication refusal uses business language: use fewer roles, permissions or field-level grants.
It leaves the draft editable and preserves every grant. There is no read-time review-size refusal;
a published, supported history remains available for a complete review. Data reset required when
applying this contract: run demo:setup to republish shipped definitions and discard earlier state.

The shipped applications have a maximum measured historical allowance of 76,241,000 bytes (the
largest role is 152,482 bytes), so they satisfy the publication rule without changing their grants.
