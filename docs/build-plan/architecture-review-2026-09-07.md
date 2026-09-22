# Historical architecture review — 7 September 2026

This historical packet is superseded by the [21 September architecture review](architecture-review-2026-09-21.md), [current roadmap](README.md) and current issue descriptions. It supplies no pickup order, worker assignment, completion gate or operational authorization. Development completion is implementation plus independent code review; no tests, database review, hosted proof or legacy-format compatibility work is required.

The review identified missing runtime composition behind service markers, flow execution identity, viewer-safe results and exact dependency adoption. Current tasks own those implementations.

Retained decisions are in [Frontend Rule Designer](../specification/appendices/frontend-rule-designer.md): explicit per-node effects, one atomic transaction per protected operation, truthful partial completion, bounded query transformations, safe privileged results and separate durable execution. Definitions grant no authority. The [core boundary](../specification/appendices/core-contract-boundary.md) places the Rule interpreter below the App coordinator; page components do not call private storage.
