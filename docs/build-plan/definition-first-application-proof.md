# First visible definition-led application

Task: [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327). Phase 6. Follow current issue/subissue scope and native dependencies; the filename is retained for existing links and does not require a proof exercise.

## Outcome

An authorized user opens an installed application and sees navigation, pages, permitted records, forms, declared actions and theme produced from ordinary definitions in the existing Next.js UI.

## What will be built

- Compose current application installation, identity/access, record/query, form/action and renderer services through their public interfaces.
- Resolve exact installed definitions and the actual request/session context at application entry.
- Render navigation, a record list and record detail; wire create/edit forms and declared actions through owning services.
- Show component-scoped loading, empty, unavailable and safe error states, including refused access and stale writes.
- Apply the installed theme and preserve responsive layout, keyboard and focus behavior.
- Use the application's ordinary definitions for names, fields and behavior. Do not add business-specific switches, mock success or a second application representation.

## Boundaries

Use the current GitHub issue as the bounded implementation contract. Already delivered engines are dependencies, not a reason to rebuild them. Visual authoring, search/files, durable workflows, connections, federation and MCP remain in later owning issues/phases.

## Acceptance

The reviewer can trace the user entry point through installed definitions, access decisions, query/record calls, form/action handlers and UI output. All named functionality is implemented with its required states; placeholder methods and hardcoded demo data do not satisfy the scope.

A fresh Opus5/Sol reviewer fixes findings itself and re-reviews before permitted source integration and issue closure. No tests, screenshot, walkthrough, database/hosted review, Testing deployment or Kestra receipt is required. The orchestrator records completion, unblocks the next ordered work and cleans the completed worktree.
