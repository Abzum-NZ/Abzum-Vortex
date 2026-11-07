# LINT-KNIP handover

PR #4023 (draft). Branch abzum-admin/LINT-KNIP, cut from origin/main 5122b7385.

Done: 8 dead exports unexported and their knipignore lines dropped; knip.json tag removed; eslint.config.mjs no-control-regex and argsIgnorePattern blocks deleted and stored-page-capability removed from rest siblings; 3 line disables added with the removed block's reason. knip clean, typecheck clean, prettier clean, guard passes, knipignore grep empty, both mutation checks pass (outputs in PR body).

Blocked: pnpm lint has 9 errors.
1. The 8 unexported consts are used only via typeof in a local type alias: no-unused-vars reports "only used as a type". Needs a design choice per file.
2. install.ts:54 `_facts` is unused once argsIgnorePattern is removed (not covered by GUARD-AUDIT finding 10).

Not run: build (held behind lint), CI guard. Next: decide the 8 consts and the `_facts` parameter, push, then run lint, build and guard, and move the PR out of draft for review.
