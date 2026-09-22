# Historical sign-in performance repair — 8 September 2026

This historical packet is superseded by the [21 September architecture review](architecture-review-2026-09-21.md), [current roadmap](README.md) and current issue descriptions. It supplies no pickup order, worker assignment, completion gate or operational authorization. Development completion is implementation plus independent code review; no tests, database review, hosted proof or legacy-format compatibility work is required.

Issue [#347](https://github.com/Abzum-NZ/Abzum-Vortex/issues/347) and [PR #348](https://github.com/Abzum-NZ/Abzum-Vortex/pull/348) recorded moving web functions to Sydney beside the database. The small historical samples measured server response times, not percentile guarantees or browser paint times; they do not require repeating deployment measurements.

The requirement is prompt organisation entry with session validation, current membership and tenant isolation. The inspected Auth SDK shared signing-key caching within each runtime; this repair needed no second cache or globally cached authority. See [hosting](../specification/17-runtime-storage-and-caching.md). Future performance work needs its own concrete scope.
