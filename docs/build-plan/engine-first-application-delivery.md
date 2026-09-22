# Definition-led application delivery

Follow the [current roadmap](README.md) and [strict pickup procedure](agent-fleet.md#strict-pickup-algorithm). This page describes product sequencing, not additional acceptance gates.

The Phase 6 outcome is a working application on the normal web UI. Its pages, navigation, forms, queries, actions and theme come from installed definitions. Persisted records and protected owning services supply actual behaviour. Issue [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327) connects the delivered Phase 1–6 engines; its [bounded scope](definition-first-application-proof.md) covers navigation, record lists and details, forms, declared actions, access decisions and theme.

## Build sequence

1. #249 and #548 establish one current Application and Module format across storage, publication and consumers.
2. #48, #49 and #50 complete record calculations, extension points and named actions. #547 owns query declarations; #54 executes permitted reads.
3. #250 compiles page bindings and current-person flow declarations. #58 executes their rules and flows; #544 connects private forms.
4. #66–#71 supply registered rendering, pages, private forms, themes, settings and navigation. #73 supplies supported definition authoring/publication. #64 assembles installed application runtime.
5. #72 supplies management definitions and bounded initial operating access; #74 supplies CRM and Service Desk definitions.
6. #327 composes these owners into actual routes, list/detail/create/edit/action screens and explicit development setup.

Native issue dependencies supply the precise order within this sequence. The visual designer in #545/#65 follows this runtime and uses the same authoring operations over the same representation. The historical HTML prototype is a reference, not a separate delivery prerequisite.

Application definitions contain business behavior. Generic publication, installation, record/query services and page rendering consume exact versions. Runtime rendering, application lifecycle and registered blocks are engine work; they do not depend on the designer that later consumes them. Definition changes alter the application without hardcoded application-specific engine changes.

## Initial setup and ordinary runtime

The setup command uses a real provisioning receipt and explicitly nominated account. A frozen server-owned manifest names exact releases and operating rights. App coordinates protected installation and the Access-owned setup operation without creating an Access-to-App dependency. Exact retries resume the same operation; later expansion uses #267.

After setup, ordinary session, selected organisation, installed release and effective Access decisions govern every request. Publishing alone does not activate a new installation. There is no fixture response, sample-specific permission bypass or inferred owner grant.

## Visible functionality

- Navigation and registered components render from the installed definition and selected theme.
- A list shows permitted persisted records and opens the selected detail.
- Create/edit forms save through Record and refresh the affected view.
- A declared named action invokes its protected owner and presents the result.
- Deliberate release adoption changes the visible application; publication alone does not.

## Later capabilities

Search/files, durable workflows, connections, sharing/federation and MCP follow their assigned phases and native dependencies. Issue #254 describes broader application integration after those capabilities exist; it does not create a backwards dependency for #327 or the designer. Missing later capabilities must be visibly unavailable rather than represented by successful mocks.

## Completion

A fresh Opus 5 or GPT 5.6 Sol reviewer inspects the integrated source path, fixes findings and re-reviews. Reviewed source integration and assigned issue closure complete this work under the fleet policy. No browser proof, screenshot, test, database/hosted verification, Testing deployment or Kestra receipt is required. Product use of definition validation, publication and installation is functionality to implement, not an agent verification exercise.
