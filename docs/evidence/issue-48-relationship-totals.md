# Relationship totals — bounded implementation evidence

[Calculated values and totals #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) ·
[Implementation plan](../build-plan/issue-48-calculation-engine.md#next-delivery-relationship-totals)

## Delivered scope under review

One pure Record evaluator calculates count, sum, minimum, maximum and average
from typed related-record inputs using the existing condition and exact arithmetic
engines. It returns final values/clears or located issues. It performs no database
reads, writes or Access decisions; supplied related rows are not evidence of
authoritative selection. A narrow Definition correction permits an explicit sum
currency when the source is a derived money field, as with ordinary money fields.

The tests cover filters and absent values, invalid present values, exact large
sums, average precision and half-even rounding, Unicode text ordering, dates and
date-time instants, yes/no ordering, money currencies and empty sets. Internal
currency diagnostics are not a caller-safe error payload.

## Consolidation verification — 10 September 2026

Independent GPT-6 Astra review found and verified two corrections across the
totals and flow-binding slices: datetime totals retain every fractional digit
accepted by the existing field contract, and node inputs enforce the fixed
current-account reference type. Focused verification passed **3 files / 22 tests**.
The [consolidation handoff](../build-plan/consolidation-handoff.md) records the
final workspace and release verification. This remains a pure engine, not a
protected database save.

## Historical verification (superseded source hashes)

The following receipt describes the earlier local candidate. Its hashes and test
counts are retained as historical evidence, not verification of the current files.

| Check | Evidence |
| --- | --- |
| Author focused tests | Two files, **15/15 passed**: totals and Module V2 publication. |
| Author regression tests | Complete Record and Definition test directories, **25 files / 416 tests passed**. |
| Types and quality | Record and Definition type checks, scoped lint/formatting, all **23 package boundaries**, and diff checks passed. |
| Independent actual-work review | **Approved by an independent Sol reviewer** against all six corrected file hashes plus the plan diagram, save-sequence specification and this evidence. The reviewer reran the focused **15/15** tests and confirmed the equal-instant ordering fix and remaining integration boundaries. |
| Root manifest check | All six SHA-256 values independently read from disk and matched. |

Frozen at base `27f60c017b4a5fa65b9b02073423e7406dfc5a51`:

| File | SHA-256 |
| --- | --- |
| [Totals evaluator](../../runtime/record/src/totals.ts) | `3f2aaa3ed0cb570da26d69a3abec154233300e24f8190c7d02cae6cafa7e6aa9` |
| [Exact arithmetic](../../runtime/record/src/exact-arithmetic.ts) | `4dd66794ad7d2a743d81d4658def89e03d252b6907e50bd187c31d62d5598a80` |
| [Record exports](../../runtime/record/src/index.ts) | `eab4a63a4f2367ea011079cbac88eb479a3a51628ba305dda9db2db7a9d4657c` |
| [Totals tests](../../runtime/record/test/totals.test.ts) | `c3ed8846e4f21c13f307c50e6cf1e32e43f0f9077235e00160f858e1aad143be` |
| [Definition validation](../../runtime/definition/src/validation.ts) | `25bc514982ad4c92bfb6d1568d1778aae2b128c83816ae9066bc41bd25d16892` |
| [Definition regression](../../runtime/definition/test/module-v2-runtime.test.ts) | `3130e2bf2f286062c79820607817774e3b08da8d7effca5c1e363b094bf3b592` |

```powershell
node node_modules/vitest/vitest.mjs run runtime/record/test/totals.test.ts runtime/definition/test/module-v2-runtime.test.ts
node node_modules/vitest/vitest.mjs run runtime/record/test runtime/definition/test
```

## Remaining acceptance

The review correction makes minimum/maximum deterministic when two valid
date-time spellings represent the same instant. After comparing instants, the
evaluator uses Unicode code-point order to break the tie. Reversing the related
row order no longer changes the chosen persisted representation. The focused
suite passed again after this correction; the 416-test broader receipt above
preceded this narrow change.

The [protected save #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) still
must select actual related records, enforce disclosure of totals, update both
old/new parents, handle concrete dependency cycles and concurrent changes, and
commit records, revisions, Activity and events atomically. This pure evaluator
does not implement or prove those database integrations. No static cross-record
type-cycle prohibition is introduced. The whole #48 remains open.

There is no new screen in this headless slice and no hosted or Production
verification claim in this evidence.
