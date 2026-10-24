# m2894 progress

## Session m2894r1 (24 Oct)
- Segment A: NOT started (no build, no lane, no script). Preflight only.
- State at start: no %TEMP%/m2894 script, no m2894 locks held; heavy.lock held by x3416 (queue before building); free RAM ~3 GB; lane locks db3/db4/db5 held by x3416/m3411/m3383 (lanes 7/8 not checked).
- Studio source map: apps/web/app/studio/[organizationId]/... , components in apps/web/app/studio/_components (module-fields-editor.tsx, application-draft-workspace.tsx, application-composition-editor.tsx).
- Target shape: packages/definitions/src/crm/{application.json,modules/*.json}.

## Exact next step
1. Count the target shape with a node script over the CRM JSON.
2. Read the Studio _components to learn selectors; write the segment A Playwright script in %TEMP%/m2894/ (modules, record types, fields of all 22 types, relationships, calculations, total, privacy, extension declarations), recording time/PASS/GAP/screenshot per step.
3. heavy-take.sh m2894, build production, lane-take.sh m2894, lane-apply.sh, demo:setup, lane-setup-done.sh, run segment A within the 20-minute cap, file gaps (milestone 21), update this file.

## Session m2894r2 (24 Oct, late)
- Segment A: still NOT started (no build, no lane, no script). Step 1 of "Exact next step" is done.
- Target shape recount over packages/definitions/src/crm on this head (differs from the brief): 6 owned modules (adds `locations`: country, region, city), 11 record types (activity, country, region, city, opportunity, opportunity_contact, company, contact, lead, tag, record_tag), 73 top-level fields, 21 field types (not 22; counts: link 15, text 12, choice 7, whole_number 4, reference_number 4, date_time 3, yes_no 3, long_text 3, and 1-2 of each other incl. calculation 2, total 1, table 1), 9 queries, 6 extension points, 11 events, 4 module flows, 6 named actions, 63 module permissions. Application body keys: pages, shells, flows, flow_bindings, roles, navigation, search, interfaces, events, connection_bindings, public_addresses.
- Free state at 21:xx: db3/db4/db5 held (m3411, m3383, x3416), setup-a held x3416, setup-b held m3383, heavy.lock free, ~5 GB free RAM. Lanes 7/8 not checked.
- Studio components for selectors: apps/web/app/studio/_components (studio-data-tab, studio-record-type-dialog, studio-module-dialog, studio-relationships-section, studio-calculation-editor, studio-total-editor, studio-module-extension-points, studio-record-storage-ownership, studio-record-standard-actions, studio-flows-panel, studio-record-pipelines, studio-record-rules, studio-module-actions, studio-access-tab).

## Exact next step
1. Read the Studio components above to learn selectors; write the segment A Playwright script in %TEMP%/m2894/ (6 modules, 11 record types, fields of all 21 types, relationships, calculations, total, privacy, extension declarations), recording time/PASS/GAP/screenshot per step. Selectors are best verified against a running Studio, so build first (heavy-take.sh), then dry-run the script's first steps on the lane before starting the 20-minute timer.
2. heavy-take.sh m2894, build production, lane-take.sh m2894, lane-apply.sh, demo:setup, lane-setup-done.sh, run segment A, file gaps (milestone 21), update this file.

## Session m2894r3 (24 Oct, late) - Segment A PARTIAL
- Built prod main, lane 5, demo:setup 4m24s, server :3398. The BOM on line 1 of .env.development.local drops VORTEX_ENVIRONMENT when sourced: strip it before `next start`.
- Playwright: node + C:/Users/vijay/AppData/Local/Temp/1037g-browser/node_modules/playwright-core. Sign-in = email+password form, password = VORTEX_DEMO_OWNER_PASSWORD.
- Done via Studio only: empty app app.crm_rebuild, 6 modules, 11 record types (persist after reload). Data URL: /studio/<tenant>/<app>?tab=data.
- Selectors: Module dialog (button 'Module' exact, dialog input, 'Add module'); Record type dialog (inputs 0/1 singular/plural, label 'Title field', 'Only this application', native select Owner, combobox 'Module', 'Add record type'). Fields: pick the record type in the tree, '+ Field' opens an INSPECTOR form (Label, Type select, Required, Format), not a dialog.
- Candidate gaps (not filed): extra default module "CRM Rebuild data"; Owner select lacks an organisation-account option (activity/lead use organization_account); inherited ownership needs the relationship first.
- NOT done: 73 fields, relationships, calculations, total, privacy, extensions; segments B, C, D.
