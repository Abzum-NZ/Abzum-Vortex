# Application packages, custom components and the installation lifecycle

[Specification index](../README.md) · [Architecture decisions of 25 September 2026](../../build-plan/architecture-decisions-2026-09-25.md) · [Composition and publication](../03-composition-and-publication.md)

An application package is the unit that people install, upgrade, uninstall and share. This appendix defines what a package contains, how custom logic is bundled safely, what installation and uninstallation must do, and how installed applications are cached.

## Package contents

A package is a signed manifest that names exact immutable releases and the files they need.

| Part | Contents |
| --- | --- |
| Application release | Pages, navigation, theme overrides, forms, component placements, flows owned by the application, experience pages. |
| Module releases | Record types, fields, relationships, computed fields, rules and named actions, queries, extension points, events. |
| Flows | Every flow the releases own, in the one flow definition shape (interactive, transaction and durable). |
| Access declarations | Permission declarations and role templates. |
| Tool bundle | The agent tools derived at publication (one per declared business operation). |
| Custom components | Browser component bundles with their component contracts (see below). |
| Custom scripts | Kestra script-task sources used by the package's durable flows (see below). |
| Assets | Images, icons and fonts referenced by the definitions. |

A package never contains records, organisation accounts, secrets, credentials, sessions, drafts or live access grants.

The manifest states:
- the publisher and the version;
- the required platform version;
- the permissions and role templates installation will present;
- whether the package includes custom components or custom scripts;
- the storage it will provision;
- the external hosts its custom components may load assets from.

## Custom logic

Builders use the first level that meets the need:

1. **Configuration** — flows with registered tasks, formulas and reference data held in ordinary records.
2. **Custom components** — browser components bundled with the package.
3. **Custom scripts** — Kestra script tasks inside durable flows.

No customer code runs on a Vortex server or in the Vortex browser origin.

### Custom components

A custom component is a JavaScript module bundle plus a component contract. The contract has the same shape as a built-in component release:

- typed properties and their defaults;
- the events it raises, with typed payloads;
- its data contract (the payload kind it accepts and the field mappings a builder sets);
- the state operations it supports;
- its accessibility name and role.

Rendering rules:

- The shared renderer draws a custom component inside a sandboxed iframe on a separate origin. The iframe has `sandbox="allow-scripts"` only, a strict Content Security Policy and no access to Vortex cookies, storage, sessions or tokens.
- The component receives only its declared properties and data payload, through a typed message bridge.
- It can only raise its declared events. The renderer validates every message against the contract and drops anything else.
- It may load assets only from the package's declared asset hosts.
- A component event starts the bound flow exactly as a built-in component event does. The component can never call a Vortex operation directly.
- The App Designer lists the package's custom components in its palette, beside the generic components, for applications that have the package installed. Builders place and configure them with the same property inspector.

### Custom scripts

A custom script is a Kestra script task inside a durable flow:

- It runs in an isolated container through the Kestra task runner.
- It has declared inputs and outputs and a time and memory limit.
- It has no database credentials and no Vortex service credentials.
- Its results reach Vortex only through the flow's next protected task, which calls a protected operation under the flow's run-as identity.
- Scripts are never used in interactive or transaction flows.

## Permissions

| Permission | Allows |
| --- | --- |
| `platform.application.author` | Create and change module and application drafts, including flows and placements. |
| `platform.application.publish` | Publish a draft as an immutable release. |
| `platform.application.install` | Install, upgrade and uninstall packages without custom code. |
| `platform.application.install_custom_code` | Install, upgrade and uninstall packages that include custom components or custom scripts. |

- These permissions are held only through roles that the organisation grants. Ordinary organisation administrators do not hold them by default.
- The same permissions govern the App Designer, the API and MCP.

## Installation

Installation has a prepare step and an activate step. A failed or abandoned preparation leaves the organisation's previous installation active and unchanged.

### Prepare

1. Verify the package signature and manifest, the platform version, and the installer's permissions, including `install_custom_code` when needed.
2. Resolve the exact module and application releases and their dependencies.
3. Provision module storage and extension fields.
4. Compile durable flows and register them in Kestra, inactive, under the installation's namespace.
5. Upload custom component bundles and assets to immutable, content-addressed storage.
6. Present role templates for acceptance. An update never silently broadens an accepted role.
7. Build the installed runtime bundle (see Caching).

### Activate

Switch the installation to the prepared release set in one atomic step, then:
- enable its Kestra triggers and schedules;
- publish its tool bundle;
- make its navigation and launcher entries visible;
- record the activation in Activity.

## Upgrade

- Prepare the new release set, then activate it atomically. The previous release set stays active if any step fails.
- Data migration follows the [version-impact policy](version-impact-policy.md). An upgrade that needs a data change runs the explicit add, migrate, switch and retire steps.

## Uninstallation

Uninstallation removes every registration the installation created. Nothing may outlive its installation.

1. **Deactivate atomically:**
   - refuse new flow starts;
   - disable Kestra triggers and schedules;
   - withdraw the tool bundle;
   - remove navigation and launcher entries.

   Background runs that are already in flight finish or are cancelled, as the uninstaller chooses.
2. **Remove registrations:**
   - delete the installation's Kestra flows and namespace;
   - end or keep assignments of the package's role templates, as chosen;
   - delete custom component bundles and assets that no other installation references;
   - delete the installation's cached runtime bundles.
3. **Handle the data.** The uninstaller chooses one of:
   - keep the records detached and restorable;
   - export them and then delete them;
   - delete them after the organisation's retention grace period.

   A legal hold always blocks deletion.
4. **Report.** Produce an uninstall report listing every removed registration and every kept item, and record it in Activity.

## Caching

Releases are immutable, so installed applications are cached by identity.

- **The installed runtime bundle.** At activation, build one bundle per installation revision. It contains:
  - compiled pages and navigation;
  - compiled flows and their trigger index;
  - theme tokens;
  - component registry entries, including custom component contracts and bundle addresses;
  - the installation access plan;
  - the tool bundle.

  Store the bundle in Postgres. Servers keep it in memory and in the Next.js/Vercel runtime cache, keyed by the installation revision.
- **The only invalidation is a change of the installation's active revision:** activation, upgrade, withdrawal or uninstall.
- **Custom component bundles and assets** are served from immutable, content-addressed URLs with long cache lifetimes.
- **Permission decisions are never cached across people.** Query results keep using the Access-version-keyed cache.

## Building with an agent

- Every builder operation is one typed, revision-checked operation shared by the App Designer, the API and MCP. The operations cover:
  - creating and changing modules, fields, relationships, pages, placements, flows, role templates and packages;
  - validating, previewing and publishing;
  - installing, upgrading and uninstalling.
- Validation returns located errors, so an agent can correct its draft and try again.
- An agent holds only the permissions of the person it acts for.

## Acceptance examples

- A package with a custom 3D component installs only for an installer holding `install_custom_code`. The component renders inside the sandbox and receives no session. Its "shape changed" event runs the bound recalculation flow.
- Uninstalling that package:
  - removes its Kestra namespace, tool bundle, navigation entries, component bundles and cached bundles;
  - keeps or deletes the records as chosen;
  - produces a report.

  A later search finds no registration that belongs to it.
- An agent acting for a person with `platform.application.author` and `platform.application.install` creates a module and a page, fixes the located validation errors, publishes, installs and opens the page, without any code change.
- Opening an installed page after activation reads no definition from the database once the runtime bundle is cached.
