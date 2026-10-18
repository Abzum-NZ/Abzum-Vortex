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

An upgrade may display additions from the selected version and removals from the previously
accepted version. Each side has its own 896 KiB allowance, giving at most 1,792 KiB. The database's
2 MiB continuation bound therefore retains 256 KiB of headroom for flow state, release identities,
bindings and release notes. The role count still has its separate 500-role ceiling, shared with the
confirmation entry count; a version must satisfy both count and volume limits.

Before returning any review, the runtime also checks an upper bound for its complete JSONB output
against 1,792 KiB. This includes the actual snapshot, binding metadata and release note. A stored
release or locally changed role configuration that exceeds that allowance receives the typed
`review_too_large` explanation in the definition-authored journey. It never reaches confirmation
storage and never accepts any of that role set. This is a safety check on the same review path.
