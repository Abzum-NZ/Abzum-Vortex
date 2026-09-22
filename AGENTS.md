# Vortex agent instructions

Read docs/build-plan/agent-coordination.md and docs/build-plan/agent-fleet.md before planning, dispatching, implementing or reviewing. They are the current fleet policy. Latest direct user instructions override historical runbooks and checkpoints.

Work through roadmap phases and numeric Pickup Order strictly. Before dispatch, read the complete issue/comments, relevant spec and main source, define one bounded outcome with owning paths, exclusions and functional acceptance, then select the cheapest capable model using complexity and provider capacity. Main orchestrator: GPT 5.6 Sol. Final independent reviewer: Opus 5 or GPT 5.6 Sol.

Implementer hands a committed candidate to a fresh reviewer. Reviewer fixes its findings itself, re-reviews, integrates permitted changes, updates/closes the assigned issue and reports. Orchestrator alone reconciles board/dependencies, releases the subagent, safely cleans the completed worktree and picks the next ordered task.

No test creation/runs, database execution/review, hosted verification, proof receipts, Kestra orchestration or deployment to Testing/Production. No additional acceptance gates. Existing repository tools do not create task requirements. Do not alter external permission controls or repository protections to evade a rejection.

Preserve tenant isolation, permissions, transactions, revisions, safe errors and explicit definition publication/installation. Fix obsolete contracts at their root; this new application needs no invented legacy compatibility. Never put business application names or special cases into generic engines. Never expose credentials. Preserve unique work before cleanup.
