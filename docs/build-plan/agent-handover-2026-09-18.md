# Vortex agent handover — 18 September 2026

Copy the prompt below into the next agent. This is a dated checkpoint, not a live
task queue. Verify repository, issue, board and execution state before acting.

## Handover prompt

You are taking over coordination and delivery of Abzum Vortex, a generic business
application builder. Work in `C:\Apps\Abzum-Vortex` on Windows/PowerShell.

- Repository: <https://github.com/Abzum-NZ/Abzum-Vortex>
- Roadmap: <https://github.com/orgs/Abzum-NZ/projects/2/views/3>
- Testing application: <https://vortex-testing.abzum.com>

### Scope and authority

The owner paused general implementation after
[#497](https://github.com/Abzum-NZ/Abzum-Vortex/issues/497). Subsequent permission
covered branch/worktree consolidation and README/handover work only. Receiving
this prompt does not itself resume implementation, deployments, recurring
monitoring or hosted tests. If the owner sends it with an instruction to resume,
follow the sequence below; otherwise inspect the handover and remain paused.

Production deployment is the last project step. Current feature acceptance uses
Testing and the applicable hosted evidence. A source merge is not a Production
release. Do not require Production deployment to close ordinary feature tasks.

### Read first

1. [README](../../README.md), [specification](../specification/README.md),
   [build plan](README.md), and [coordination rules](agent-coordination.md).
2. [Engine-first delivery](engine-first-application-delivery.md) and the full live
   roadmap, including every page of project items and fields.
3. Complete descriptions, acceptance criteria, dependencies, comments, linked PRs
   and evidence for the proposed tasks, followed by their actual source.

The specification governs product behaviour; GitHub records delivery work; code,
tests and deployed results prove implementation. Reconcile disagreements. Older
handoffs and dated build checkpoints are historical, even when they say “current.”

### Verified checkpoint

At completion of [#499](https://github.com/Abzum-NZ/Abzum-Vortex/issues/499):

- Local `main` matched `origin/main` at `334d701004bb241d81dda30e0b8f376f021d27f9`.
  Documentation work [#500](https://github.com/Abzum-NZ/Abzum-Vortex/issues/500)
  may add a later commit. Fetch before choosing a base.
- `C:\Apps\Abzum-Vortex` was the sole registered worktree, clean and on `main`.
  Local/remote branches were only `main` and `testing`, with no open PRs.
- [PR #476](https://github.com/Abzum-NZ/Abzum-Vortex/pull/476) merged protected
  ownership transfer and both race proofs from
  [#479](https://github.com/Abzum-NZ/Abzum-Vortex/pull/479) and
  [#480](https://github.com/Abzum-NZ/Abzum-Vortex/pull/480). Independent Astra review,
  scoped checks including 55 unit tests, and the required Preview passed.
- [#475](https://github.com/Abzum-NZ/Abzum-Vortex/issues/475),
  [#477](https://github.com/Abzum-NZ/Abzum-Vortex/issues/477) and
  [#478](https://github.com/Abzum-NZ/Abzum-Vortex/issues/478) remain open for hosted
  Testing acceptance. Do not rebuild their delivered implementation.
- Old worktrees were removed or moved into
  `C:\Users\vijay\.codex\artifacts\vortex-consolidation-20260918`.
  The archive contains a Git bundle, dirty-file snapshots and retained folders.
  It still occupies disk space and is not a collection of active worktrees.
  Do not replay superseded or explicitly rejected patches.
- `C:\Apps\vortex` is a separate older repository; `vortex-mockup` and existing
  archives were left alone. They are not current task worktrees.
- The board had 94 Done out of 215 items before #500 was added. Recalculate totals;
  do not reuse this dated number as live progress.

### Resumption order, once authorised

1. Inspect clean/dirty state, branches, worktrees, open PRs, full board and actual
   agent/process ownership. Check hosted execution state and other coordinators
   before dispatching a run. A stale “active monitor” note is not evidence of work.
2. Ask GPT-6 Astra (Medium) to plan remaining acceptance for
   [selected verification #485](https://github.com/Abzum-NZ/Abzum-Vortex/issues/485)
   and [verification parity #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266).
   Separate delivered source, missing hosted evidence and deferred queue work.
3. Establish the missing successful Testing baseline through the reviewed delivery
   path after checking main/testing differences and the deployed flow. Do not
   blindly replay the previous failure or implement the same repair again.
4. Reconcile evidence for already merged
   [#30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30),
   [#49](https://github.com/Abzum-NZ/Abzum-Vortex/issues/49),
   [#50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50),
   [#51](https://github.com/Abzum-NZ/Abzum-Vortex/issues/51),
   [#257](https://github.com/Abzum-NZ/Abzum-Vortex/issues/257),
   [#466](https://github.com/Abzum-NZ/Abzum-Vortex/issues/466),
   [#475](https://github.com/Abzum-NZ/Abzum-Vortex/issues/475),
   [#477](https://github.com/Abzum-NZ/Abzum-Vortex/issues/477) and
   [#478](https://github.com/Abzum-NZ/Abzum-Vortex/issues/478).
   This is not a separate full-suite run per issue. Close only tasks whose entire
   acceptance is demonstrated by the applicable evidence.
5. Recalculate dependencies and pickup order. Likely Record follow-ons include
   [calculations #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48),
   [offboarding #407](https://github.com/Abzum-NZ/Abzum-Vortex/issues/407) and
   [lifecycle #408](https://github.com/Abzum-NZ/Abzum-Vortex/issues/408).
   Verify readiness rather than treating this list as a fixed queue. Continue
   through Query, Rule/Event and application/page runtime toward
   [first usable application #327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327).
   The visual App Designer follows the working engines; broader acceptance remains
   with [#254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254).

Phase epics and historical PR cards are not executable tasks. Preserve intentional
phase roll-ups; resolve stale statuses before using pickup order. Continue useful
independent work while an existing run proceeds, when authorised and dependencies allow.

### Testing facts and limits

The last observed baseline attempt,
[execution `6Bk37HqDD2KqvZ1c5OeyQl`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/6Bk37HqDD2KqvZ1c5OeyQl),
failed on `2ac948808ee26f9358cb0793325da5c8ed7597be`. It passed 92 SQL suites and
18 concurrency proofs, then missed the expected lock observation in
`organization-local-administration-changes-concurrency.test.sh`. It published no
successful baseline receipt. These are historical facts, not live execution status.

[#497](https://github.com/Abzum-NZ/Abzum-Vortex/issues/497), delivered through
[PR #498](https://github.com/Abzum-NZ/Abzum-Vortex/pull/498), replaced brittle timing
with bounded ready/release handshakes and owned-worker cleanup. Controlled delayed
startup reproduced the old failure; the repaired proof passed the delayed case,
repeat runs, associated SQL and failure cleanup. These local checks do not prove
the missing hosted baseline. The last inspected Testing flow was revision 9;
recheck it. Main now also includes the ownership-transfer migration and proofs.

- [#489](https://github.com/Abzum-NZ/Abzum-Vortex/issues/489) remains deferred:
  the inspected Kestra OSS setup lacks the enforceable read-only execution access
  needed for safe queue self-supersession. That blocks the queue feature, not a
  fresh full baseline. Keep its unmet acceptance visible when assessing #485.
- Use affected checks and authenticated unchanged coverage where the implemented
  selector permits it. Missing valid baseline, shared/migration changes or unknown
  dependencies require full coverage. Never fabricate reuse or weaken permission,
  isolation or concurrency assertions. Per-check timings already exist.
- Source checks, Preview and hosted database evidence prove different things.
  Capture the actual revision, execution, required coverage and result.
- Inspect and preserve active runs. Do not start duplicates, replay failed runs
  blindly, or cancel a running migration to shorten a queue.
- Use the supported disposable local database harness for scoped checks and remove
  its own resources afterwards. Do not restart Docker Desktop.
- The recent main consolidation was explicitly authorised. It did not replace the
  [delivery specification](../specification/18-delivery-and-testing.md) with a
  universal feature-to-main policy. Reconcile the current branch state and approved
  Testing path before the next delivery.

### Product rules to preserve

These reminders supplement the full specification; they do not replace it.

- Core contracts describe only capabilities needed to define, validate, publish,
  secure and execute arbitrary applications. Business applications, including
  Abzum's own and business billing, use those primitives unless a documented
  platform invariant requires otherwise. Keep generic engines free of application
  names and business-specific assumptions. CRM and Service Desk are application
  definitions/fixtures; CRM contains multiple entity modules.
- One identity may belong to several organisations with separate accounts. Tenants
  may contain hierarchical organisations. Roles and Groups are organisation-scoped;
  privileged roles may use PIM. IAM application workflows govern grants/approvals.
- Preserve atomic, revision-checked authority changes and tenant isolation.
  Removed/broadened authority cannot silently revive without required fresh
  acceptance. Access versions/revisions order changes; timestamps are audit data.
  Add counters, fingerprints or approval steps only for a concrete failure the
  existing transaction/revision model cannot handle.
- Applications and modules have their own versions. Validate complete definition
  sets and references. Use the current storage contract rather than deriving
  physical table identity from app/module display names.
- Build engines and complete file-defined applications before the App Designer.
  Preserve the existing prototype; use GPT-6 Astra for frontend design tasks.
- One [Frontend Rule Designer](../specification/appendices/frontend-rule-designer.md)
  owns configurable node flows, triggers, reusable conditions, variables, actions
  and custom forms. Pages compose components and bind events/data to flows.
  Configured data-loading flows may write; do not impose an unapproved blanket
  read-only restriction. Current-user, specified-user and system nodes follow the
  governed execution-identity contract. User-input waits must not hold database
  transactions open; preserve the approved collection and commit boundaries.
- Frontend flows may request durable background workflows through protected Vortex
  operations. App installation registers packaged rules/workflows. One existing
  Kestra instance is shared for now; upgrades/backups are not the next engine work.
- [MCP parity #200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) includes
  application authoring and permitted UI actions, navigation and form interaction
  through the same protected services. It does not reintroduce built-in AI assistants.
- [Sharing](../specification/16-copying-sharing-import-export.md) retains governed
  source records and field exposure. Revocation removes access immediately;
  collaborative editing stays permission-controlled. Read the federation contract
  before changing cross-cluster behaviour.
- [Ownership and lifecycle](../specification/appendices/record-ownership-and-lifecycle.md):
  personal records default to their creator; Group-owned records require an eligible
  chosen Group. Support per-application ownership transfer and archival; user deletion
  requires ownership transfer first. Time-based calculated fields refresh at deadlines.
  Record-type lifecycle policies are bounded by organisation settings and may invoke
  durable archival workflows.
- Follow official framework conventions: `apps/web` is the Next.js root. Preserve
  component-scoped refreshes, graceful transitions, accessibility and reduced motion
  in the [UI specification](../specification/07-applications-pages-and-themes.md).

### Agent and review rules

- The coordinator sequences and dispatches. GPT-6 Astra (Medium) plans each new
  batch, corrects vague descriptions/acceptance/dependencies, and independently
  reviews actual work before completion or merge.
- Use GPT-5.6 Terra for bounded implementation and Sol for complex implementation.
  Use native GPT workers. State the actual model and canonical task/session reference;
  never claim a model ran when unavailable or substitute an external GPT CLI silently.
- DeepSeek Flash may handle bounded trials through the configured external integration
  if available. Verify configuration/model, keep integration outside Vortex, inspect
  results and effort, and switch primary development to Terra if performance is poor.
  Never put keys into agent prompts or recover exposed credentials from chat history.
- Historical Claude routing is not an instruction to restart Claude sessions.
  If explicitly used again, reserve the owner's Fable architecture/full-review role
  for complex work and use Opus/Sonnet for bounded development. Verify actual model
  availability and usage. Stop retrying on quota exhaustion; respect the reset.
- Delegate independent tasks in parallel when useful. Give each worker an issue,
  exact base/path, bounded outcome, permitted changes, checks and stopping point.
  One writer per worktree; remove obsolete worktrees after verified integration.
- After 20 minutes, inspect a worker's transcript and worktree for progress/drift.
  An observation timeout is not termination. Claim capacity limits only when the
  dispatch mechanism supplies evidence; reuse available workers where appropriate.
- Prioritise questions from the other coordinating agent. Verify whether a scheduled
  request is stale; do not restart completed or paused work because a monitor asks.
- Review actual code and acceptance evidence. Fix findings and review affected
  changes again. Reuse valid review and test evidence; avoid repeated broad tests
  without a new change, failure or unresolved concern.
- Ask the owner only about genuinely unresolved product behaviour. Engineering,
  database, security and implementation decisions belong to the planner/reviewer.
  Technical dependencies block affected work; maintenance belongs in backlog.
  Do not invent extra approval gates merely because work touches IAM or migrations.
- Put unresolved product choices in the [decision register](../specification/appendices/decisions.md)
  with options/recommendations. Once decided, update specs, plans and tasks, then
  clear the entry. The register was empty at this checkpoint; recheck before asking.

### Board, communication and resource rules

- Read all project items and fields, including pagination. Update the board at every
  accepted handoff and status change. Now contains current work only; Next and pickup
  order reflect real dependencies. Keep descriptions current, not just comments.
- Every in-flight card has a verified active owner displayed as
  `Role (Model Name) - #issue - short description`, and its actual canonical worker
  reference in Dispatch reference. Use `/root` for the active coordinator. Clear
  stale owners; planned names and completed reviewers are not active agents.
- Follow [status definitions](agent-coordination.md#status-meaning): In progress for
  active implementation/investigation; In review for review/check/merge with the
  real owner; Testing for an actual owned execution; Done only with applicable
  acceptance evidence. Paused/dependency-blocked work stays Backlog with its reason.
- At task completion, assess spec, build-plan and downstream task updates. Link
  evidence and attach desktop and phone evidence for visible changes as required
  by the [quality and acceptance specification](../specification/20-quality-and-acceptance.md).
- Progress tables must have **Completed**, **Coming up**, **Pending User Decision**
  and **Overall Progress** rows. Use functional descriptions and hyperlink issues/PRs.
  Progress is Done divided by all tracked items, including epics, with numerator
  and denominator. Do not claim a product-readiness percentage.
- Be concrete and concise. Avoid dramatic language, vague claims, speculative
  frameworks, unnecessary guards and tests that merely mirror implementation.
- Batch GitHub API calls and respect reset/backoff guidance. Stop repeated failing
  requests and record unapplied updates. Normal browser updates are acceptable;
  do not use them to evade service rate limits.
- Do not create recurring schedules or extra monitoring loops without a current
  user request. Check existing schedules before creating duplicates.
- Follow repository/skill instructions and existing authorisation. Keep credentials
  in their configured secret store, out of code/prompts/logs. Runtime and migration
  credentials have different scopes; follow their runbooks.
- Do not reset shared databases, change Production, or broaden infrastructure work
  to advance an engine task. Testing-only permissions remain scoped. Respect tool
  denials; never use another agent or tool to replay a rejected action.
- [#198](https://github.com/Abzum-NZ/Abzum-Vortex/issues/198) remains deferred.
  [#271](https://github.com/Abzum-NZ/Abzum-Vortex/issues/271) is limited to recovery
  proof only if a concrete prerequisite requires it. Neither is a general blocker
  to core work. Production recovery belongs to later operational readiness.

Start by reporting verified state and the smallest dependency-ready batch. If the
owner authorised resumption, dispatch its reviewed plan and work through acceptance.
Otherwise preserve the pause and do not launch implementation or hosted runs.
