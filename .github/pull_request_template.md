## What changed

Issue #
Describe the behaviour implemented and its scope.

## Walkthrough

Pages exercised on a freshly reset local database (sign-in, then each affected page), with screenshots when the change is visible.

## Checklist ([target architecture](../docs/build-plan/target-architecture.md))

- [ ] Root cause fixed, not a workaround at the symptom.
- [ ] No new layer, `V2`/`V3` copy, receipt, fingerprint or other process artefact.
- [ ] No business application names in engines; no absent-setting behaviour; no hard-coded shell, navigation or theme.
- [ ] Errors keep their cause in the server log; no silent `null` on platform data.
- [ ] Organisation isolation, current permission checks, atomic writes and revision checks preserved.
- [ ] Schema changes ship as a new migration; changed functions keep the `supabase/schemas` file identical to the migration.
- [ ] `pnpm guard` and `pnpm typecheck` pass.
- [ ] Blocking guard findings are fixed or have an occurrence-specific `guard-allow` reason the reviewer agrees with; a changed feature that a guard rule covers updates or removes that rule.

## Guardrail review

The rules, their tiers and review-by dates live in `tooling/guard/config.ts`. Any blocking finding fails CI; file size is a warning.

For an intentional exception, add `// guard-allow: <rule> <reason>` on the offending line or the line directly above it. SQL supports `-- guard-allow: <rule> <reason>`; block comments support `/* guard-allow: <rule> <reason> */`. Use a real rule id and explain the reason in at least 10 characters. Each directive covers one occurrence and is reported by the guard. Exceptions are suitable only when the finding is intentional and a direct fix is not appropriate; the reviewer must agree with the reason.
