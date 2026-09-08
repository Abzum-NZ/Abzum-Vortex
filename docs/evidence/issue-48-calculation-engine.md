# Calculation engine — first delivery evidence

[Calculations and totals #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) ·
[Reviewed implementation plan](../build-plan/issue-48-calculation-engine.md) ·
[Calculation specification](../specification/05-modules-fields-and-relationships.md#calculations-and-totals)

## Delivered scope

The pure Record evaluator implements the six existing Module V2 calculation
forms: numeric operations, percentage subtraction, text joining, typed conditions,
date offsets and deadline checks. Application definitions select their operands,
dependencies and result settings; no application-specific behavior is embedded in
the engine.

Arithmetic uses exact rational intermediates and one final half-even rounding
step at explicit precision. Currency meaning is preserved. Dates use the supplied
operation clock, not an independently sampled wall clock. Dependency ordering
recomputes calculation fields instead of trusting an old result; absent optional
results are cleared and missing required results are refused.

The authored and published V2 schemas carry precision without rewriting historical
releases. New publication and execution require precision where applicable;
historical reads remain possible. Calculation/total settings already participate
in the existing major-version impact comparison. The editable example definition
now supplies its required precision.

## Verification

| Check | Evidence |
| --- | --- |
| Focused evaluator and fixture coverage | Author and independent reviewer each ran the five-file suite: **34/34 passed**. It covers the six forms, exact arithmetic, currency meaning, dates, dependency order and current application fixtures. |
| Broader affected packages | Author's run covered **28 files / 529 tests**, including Contracts, Definition, Record and both current fixture gates. All passed. |
| Package verification | Author reports Contracts, Definition and Record type checks passed, scoped lint/format passed, and all **23 package boundaries** passed. |
| Independent actual-work review | **Approved** by an independent Sol reviewer against the exact frozen fourteen-file implementation. The reviewer also ran Definition comparison/cycle coverage: **233/233 passed**, confirmed matching file hashes and found no concrete defects. This was actual-patch review, separate from the previously approved architecture plan. |

Focused command:

```powershell
.\node_modules\.bin\vitest.cmd run --root . contracts/test/module-v2-calculation-precision.test.ts runtime/definition/test/module-v2-runtime.test.ts runtime/record/test/calculations.test.ts testing/fixtures/current-module-v2-runtime.test.ts testing/fixtures/validate-fixtures.test.ts
```

Broader command:

```powershell
.\node_modules\.bin\vitest.cmd run --root . contracts/test/module-v2-calculation-precision.test.ts contracts/test/domain-contracts.test.ts contracts/test/module-v2-definition-plumbing.test.ts runtime/definition/test runtime/record/test testing/fixtures/validate-fixtures.test.ts testing/fixtures/current-module-v2-runtime.test.ts
```

## Remaining acceptance

This delivery does not complete the whole issue. Relationship totals, authoritative
dependency reads, protected persistence, caller-specific disclosure and concurrent
saves must be integrated with [save pipeline #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47)
on [protected storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45).
Supplied total values are inputs to this evaluator, not proof of recomputed totals.

No database migration, hosted database verification or Production promotion is
claimed by this calculation-only evidence. There is no new screen to screenshot.
