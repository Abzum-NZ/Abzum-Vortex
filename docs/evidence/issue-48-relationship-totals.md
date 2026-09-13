# Relationship totals — bounded implementation evidence

[Calculated values and totals #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) ·
[Implementation plan](../build-plan/issue-48-calculation-engine.md#next-delivery-relationship-totals)

## Stage 2B transactional save integration — 14 September 2026

The existing protected create/update save transaction now privately discovers the
old and proposed concrete total closure before row locks, locks the source and
affected parents in canonical physical-record order, and re-reads revisions,
relationships and closure after any wait. A changed closure restarts the owning
request transaction at most three times using the same command, expected revision,
Activity identity and lazily allocated Event identity.

The Record service evaluates only server-read installed definitions and declared
aggregate/filter inputs. It applies the existing total, calculation and final field
validators, then composes the existing base save with revision-checked parent total
and dependent-calculation updates. Source and parent Records, revisions, Activity,
standard Events/queue messages and the existing save receipt commit or roll back as
one unit. No public related-row reader, receipt, table or generic save/evaluator
framework was added.

The real PostgreSQL integration publishes, provisions and installs V2 definitions,
then proves empty required totals and an upstream calculation, child create, value
change, filter exclusion/re-inclusion, old/new-parent movement, concurrent children
sharing a parent, stale revision, effect-free replay and changed-input duplicate.
It now also proves a finite recursive installed hierarchy, an actual concrete
record/field cycle refusal, mixed-currency refusal with no partial effects, and a
forced lock wait whose changed relationship closure restarts and completes once.
A second forced wait overlaps two exact retries: both replay the same saved revision
while only one receipt and one source/parent effect pair commit. An injected parent
Activity failure still proves rollback of the already-written source and all other
terminal effects.

The correction preserves the existing installation-wide Rule eligibility boundary:
when an installed Module or Application contains a Rule, the relationship preflight
delegates to the existing base preparation instead of bypassing its refusal. The
database proof injects a canonical Rule into the already published/provisioned/
installed test release under replication-disabled fault setup, calls the protected
runtime preflight, and observes only `defer` with no effects. The obsolete unjoined
base writer is no longer executable by `vortex_runtime`; the composed writer also
reruns the protected preflight inside its own security-definer execution and
matches the supplied parent identities, revisions, and complete generated-field
set to that fresh authoritative closure. No caller-set session state or preparation
token participates. The real runtime proof supplies the correct parent identity
and revision with `finalValues: {}` and confirms refusal leaves the source, parent,
receipt, Activity, Event and queue unchanged.

Verification completed on a fresh disposable database:

- Record focused tests: **4 files / 27 tests passed**.
- Real published/provisioned/installed PostgreSQL save: **1 file / 1 test passed**.
- Transactional-total ACL pgTAP: **13/13 passed**.
- Record typecheck, scoped lint, all **23 package boundaries**, database migration
  reset and database lint passed. Database lint reported only pre-existing warnings.
- Fresh disposable PostgreSQL pgTAP suite: **85 files / 4,036 tests passed**.
- Repository unit suite: **155 files passed, 6 skipped; 1,916 tests passed,
  7 skipped**. All **23/23** package typechecks and builds passed; formatting,
  repository lint and the **18/18** current fixture checks passed.

The post-review correction reran the focused **4 files / 27 tests**, the real
PostgreSQL integration (**1/1**), all **23/23** package typechecks, repository
lint/formatting/boundaries, database lint, and the fresh **85 files / 4,036**
pgTAP suite successfully. The separate repository-wide concurrency runner was
also attempted: its Record-independent Access-administration fixture failed to
reach its barrier after reporting a stale organisation-account revision. That
runner is not claimed green; the two Stage 2B real lock-wait cases above both
passed deterministically in the focused PostgreSQL integration.

The second review correction reran the focused **4 files / 30 tests**, the
transactional-total ACL **13/13**, and the real installed-definition PostgreSQL
integration **1/1** successfully after a fresh local reset. The changed-closure
case now records exactly two real request transactions (the restarted attempt and
successful retry), observes the row-lock wait, and asserts the old/new parent
totals and exact terminal-effect deltas without any post-save repair. A fresh
disposable PostgreSQL run again passed **85 files / 4,036 tests**.

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

The historical pure-evaluator receipt above predates the Stage 2B integration.
Deletion/restore, broader relationship behaviors, deadline scheduling/refresh and
Query remain owned by #50, #49, #62 and #54 respectively. No static cross-record
type-cycle prohibition is introduced; only an actual concrete record/field cycle
is refused.

There is no new screen in this headless slice and no hosted or Production
verification claim in this evidence.
