# Historical Claude engine handoff — 10 September 2026

This is a completed assignment snapshot, not current task sequencing or authority
to restart its workers. Consult the [live board](https://github.com/orgs/Abzum-NZ/projects/2/views/3)
and [engine-first plan](engine-first-application-delivery.md) before assigning work.

## Assignment

- Coordinator/reviewer: Codex. Architect: Claude Fable 5.1. Developer: Claude Opus 5.
- Integration base: `db430d6236a78d96f84536ff47b5028a3bb4d720`, merged Testing
  [PR #369](https://github.com/Abzum-NZ/Abzum-Vortex/pull/369).
- Working directory: `C:/Apps/Abzum-Vortex/.tmp/application-module-value-pairs`.
- Coordination branch: `codex/claude-engine-handoff`.
- Owning task: [#45 — Turning a definition into tables](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45).
- Consumers: [#43 — Module lifecycle](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43),
  [#47 — Protected save](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47),
  [#58 — Frontend rules](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58).

## Delivered facts and next functional outcome

Published Module 3 definitions now carry the shared before-save graph and the
Rule engine executes its eight supported nodes. Record candidate preparation
permits configured later rules to supply or correct values before final checks.
See [the exact milestone evidence](../evidence/issue-58-before-save-rule-runtime.md).
This is not a complete protected database save or activated installation.

The existing database provisioner in
`supabase/migrations/20260908122641_record_storage_provisioning.sql` checks the
exact Module 2 validation pair. Module 3 reuses the V2 field model. Determine the
smallest correct change that lets the existing storage engine consume the exact
supported Module 3 pair and reuse compatible V2/V3 physical storage. A rule-only
definition change must not create a new table or relabel an immutable release.

Read [module/record provisioning](module-record-provisioning.md),
[shared Rule plan](issue-58-shared-rule-graph-foundation.md),
[protected save plan](issue-47-save-command.md), and
[storage specification](../specification/17-runtime-storage-and-caching.md).
Inspect actual contracts, provisioner, consumer readers and tests before proposing
changes. Existing issue text is context, not proof of implemented behaviour.

## Architecture deliverable

Return a concise, evidence-backed plan: current path and exact gap; smallest
implementation; files/functions affected; supported version semantics; tests that
prove the outcome; real remaining dependencies; and any specification/task text
that is inaccurate. Distinguish this compatibility slice from complete storage,
activation and save delivery. Challenge needless complexity, but do not weaken
tenant isolation, access checks, exact dependency resolution or concurrency.

Architecture session is read-only. Do not edit files, run database commands,
install dependencies, launch subagents, contact hosted services or implement the
plan. Stop after returning it. The coordinator then assigns implementation.

## Exclusions and safety history

No transitive-dependency coordinator replacement, Access/field-policy changes,
Event queue/outbox work, totals engine changes, activation, save writer, UI,
Kestra work, resets or Production promotion belongs in this initial assignment.
There were earlier tool safety denials affecting a transitive provisioner patch,
privileged Event helpers and other historical worktrees. They remain binding;
do not recover, copy, execute or repackage those rejected payloads. If a proposed
change requires that work, identify the dependency without attempting it through
another agent or tool. A new model is not a way around a denied action.

Use the [coordination rules](agent-coordination.md). No new coordinator framework,
duplicate validator, speculative version compatibility layer or extra counter.

## Session verification

Claude Code updated to 2.1.266 and subscription authentication verified.
No-tool availability checks returned the exact resolved models:

- `claude-fable-5-1`: session `17b0b418-1b35-4529-b1e8-4116e7643266`.
- `claude-opus-5`: session `91bb7aab-0be3-4d40-a38c-0e0a181a8f28`.

These checks prove availability, not architecture review or implementation.

The first repository-reading architect launch was blocked pending explicit
authorization to send relevant private repository source, specifications and task
context to Anthropic. The user subsequently explicitly authorized that transmission
on 9 September 2026. The coordinator may now run the scoped architect/developer
handoffs, excluding credentials, secret files and unrelated content. Other prior
safety denials remain binding; this authorization does not approve their payloads.
