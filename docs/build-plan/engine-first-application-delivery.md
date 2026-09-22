# Engine-first application delivery

Follow the [current roadmap](README.md) and [strict pickup procedure](agent-fleet.md#strict-pickup-algorithm). This describes product sequencing, not additional acceptance gates.

## Phase 6 outcome

Build an installed definition-led application in the existing Next.js UI before visual designer work. Issue [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327) connects delivered Phase 1–6 engines. Its [bounded scope](definition-first-application-proof.md) covers navigation, record lists/details, forms, declared actions, access decisions and theme.

Application definitions contain business behavior. Generic publication, installation, record/query services and page rendering consume exact versions. Publishing alone does not activate a new installation. Current session and organisation permissions govern each operation. Definition changes alter the app without hardcoded application-specific engine changes.

Runtime rendering, application lifecycle and registered blocks are engine work. They do not depend on the designer that later consumes them. Phase 7 adds visual authoring over those same protected operations and the same representation.

## Later capabilities

Search/files, durable workflows, connections, sharing/federation and MCP follow their assigned phases and native dependencies. Issue #254 describes broader application integration after those capabilities exist; it does not create a backwards dependency for #327 or the designer. Missing later capabilities must be visibly unavailable rather than represented by successful mocks.

## Completion

A fresh Opus 5 or GPT 5.6 Sol reviewer inspects the integrated source path, fixes findings and re-reviews. Reviewed source integration and assigned issue closure complete this work under the fleet policy. No browser proof, screenshot, test, database/hosted verification, Testing deployment or Kestra receipt is required. Product use of definition validation, publication and installation is functionality to implement, not an agent verification exercise.
