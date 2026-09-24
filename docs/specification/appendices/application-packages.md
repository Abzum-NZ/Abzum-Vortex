# Application packages, custom components and the installation lifecycle

[Specification index](../README.md) · [Architecture decisions of 25 September 2026](../../build-plan/architecture-decisions-2026-09-25.md) · [Composition and publication](../03-composition-and-publication.md)

An application package is what people install, upgrade, uninstall and share. This appendix defines:
- what a package contains;
- how custom components are bundled and isolated;
- how platform-reviewed custom scripts are installed;
- what installation and uninstallation must do;
- how installed applications are cached;
- how agents build applications.

## Packages are derived from published applications

Publishing an application derives its package. The package is that application release plus its exact dependency closure. It is not a third publishable kind: there is no package draft and no separate package version, and installation resolves nothing.

| Part | Contents |
| --- | --- |
| Application release | Pages, navigation, theme overrides, forms, component placements, experience pages and the flows the application owns. |
| Module releases | Record types, fields, relationships, computed fields, flows (rules and named actions), queries, extension points and events. |
| Access declarations | Permission declarations and role templates. |
| Tool bundle | The agent tools derived at publication. |
| Custom components | Browser component bundles with their component contracts. |
| Custom scripts | Platform-reviewed Kestra script-task sources, present only in packages installed by a Vortex super administrator. |
| Seed reference data | Optional records, such as a price list, imported once at activation as ordinary organisation records. |
| Assets | Images, icons and fonts referenced by the definitions. |

A package never contains records other than declared seed reference data. It also never contains accounts, secrets, credentials, sessions, drafts or live access grants.

The package manifest lists:
- the exact release identities and fingerprints;
- the required platform version;
- the permissions and role templates that installation will present;
- whether the package includes custom components;
- the storage it provisions;
- the external hosts its custom components may load from;
- its seed reference data.

Signatures are added only when a package crosses clusters ([16](../16-copying-sharing-import-export.md)). Inside one cluster, the release fingerprints are enough.

## Custom logic

Builders use the first level that meets the need:

1. **Configuration.** Flows, registered tasks, formulas and reference data held in ordinary records.
2. **Custom components.** Browser components bundled with an application or module release.
3. **Custom scripts.** Platform-reviewed code, installed only by Vortex super administrators (see below).

Customer-authored code never runs on a Vortex server, in Kestra or in the Vortex browser origin.

### Custom components

A custom component is a JavaScript module bundle plus a component contract. The contract has the same shape as a built-in component release:
- typed properties with defaults;
- declared events with typed payloads;
- a data contract;
- supported state operations;
- an accessible name.

A custom component belongs to the application or module release that bundles it. Only that application, or applications that depend on that module, may place it. Any change to a bundle is a major version change.

**Isolation.** Every rule below is required:

- **Bootstrap document.** The renderer loads each custom component through a Vortex-owned bootstrap document. That document is served from a dedicated registrable domain that is never a Vortex application origin. The bootstrap document is served with this header:

  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <bundle host> 'wasm-unsafe-eval'; style-src <bundle host> 'unsafe-inline'; worker-src blob:; connect-src <bundle host> <declared hosts>; img-src <bundle host> <declared hosts> blob: data:; media-src <bundle host> <declared hosts> blob:; font-src <bundle host> <declared hosts>; frame-ancestors <Vortex origins>`

  The bundle host sends `Access-Control-Allow-Origin: *`, because module scripts and model files load into an opaque-origin frame.
- **Loading.**
  - The bootstrap document loads the bundle with Subresource Integrity, using the digest recorded in the release.
  - Its URL carries no organisation, record or person identifier.
- **Sandboxed frame.** The frame is sandboxed with `allow-scripts` only. It has no access to Vortex cookies, storage, sessions or tokens.
- **Message channel.**
  - All communication uses one `MessageChannel` port, transferred to the frame when it loads.
  - The renderer validates every message against the declared events and drops anything else.
  - The frame's origin is opaque, so `event.origin` is never used to authenticate a message.
- **Data sent to the component.** Every value sent to a custom component is treated as disclosed to the package's publisher. The renderer sends only the fields mapped to the component and readable by the viewer. It sends no field classified as sensitive unless the installer explicitly approved that at install.
- **Events from the component.** Events are untrusted input and carry no evidence of a user gesture.
  - An event starts a flow only through its binding.
  - The renderer allows one in-flight flow per binding and coalesces repeated events.
  - A flow that changes data after a custom-component event shows a host-rendered confirmation before its first change.
- **Placement.** Custom components are page-level blocks, never placed inside another component. They must handle loss of the graphics context (for example a WebGL context loss) by re-rendering.
- **Accessibility.**
  - The frame's `title` is the component's accessible name.
  - The host renders the component's declared text alternative.
  - The host renders non-dragging inputs for every value the component lets a person change, as required by WCAG 2.5.7.
  - The host passes the application's theme tokens as properties.
- **Designer.** The App Designer lists a custom component in the palette only where it may be placed, and configures it with the ordinary property inspector.

### Custom scripts

Custom backend scripts are platform-reviewed code, not customer code:
- **Who installs them.** Only a Vortex super administrator can add a script to a package and install a package that contains scripts. They do so after reviewing and testing it. Installation by anyone else is refused.
- **Where they run.** A script runs as a Kestra script task inside a durable flow, on the application Kestra instance. That instance's environment holds only the callback signing key.
- **What they can use.** The script source is passed as a file, never as a rendered template property. A script receives only its declared inputs and has time and memory limits.
- **How results return.** Results reach Vortex only through the flow's next protected task, which runs under the flow's run-as identity.
- **When they run.** Scripts run asynchronously. Values that must be authoritative at save time use formulas.

## Permissions

| Permission | Allows |
| --- | --- |
| `platform.organization.definition_drafts.manage` | Create and change module and application drafts, including flows and placements. |
| `platform.organization.definition_releases.manage` | Publish drafts as immutable releases. |
| `platform.organization.applications.manage` | Install, upgrade and uninstall packages. This permission already exists. |
| `platform.organization.custom_code.manage` | Required in addition to `applications.manage` when a package contains custom components. |
| `platform.organization.system_applications.manage` | Change system applications. |
| Vortex super administrator (platform operator, never a customer role) | Install packages that contain custom scripts, and operate Kestra. |

These permissions have further rules:
- **Approvals and the one fixed rule.** The organisation's approval workflow decides who must approve a grant, and the required-caller policy can make that workflow mandatory. Independently of any workflow, the grant operation refuses any role or role template that contains a permission outside the actor's own delegated scope ([04](../04-access-and-permissions.md)). Workflows are editable definitions, so this rule is what stops anyone granting themselves more than they hold.
- **Recent authentication.** Installing custom components, or accepting role templates, requires the person's recent authentication.
- **Who holds them.** Ordinary organisation administrators do not hold these permissions unless a role grants them.

## Installation

Installation is one command. Its inputs are the package, the installer's confirmation of the manifest, and the role templates the installer accepts.

**Prepare.** A failure at any point leaves the previous installation active:
1. Verify the platform version and the installer's permissions.
2. Provision module storage and extension fields.
3. Compile the durable flows and register them in Kestra as inactive, under a namespace generated for this installation.
4. Upload custom component bundles and assets to immutable, content-addressed storage.
5. Build the runtime bundle (see Caching).

**Activate.** This is one transaction:
- move the installation's active revision;
- import seed reference data the first time only. The import runs under a System actor scoped to the package's seed record types, and the records pass normal validation and BeforeSave rules;
- increment the Access version;
- record the activation in Activity.

Navigation, launcher entries and agent tools follow from the active revision. Kestra triggers and schedules are enabled after the commit ([09](../09-workflows-and-pipelines.md)).

Prepared candidates that are never activated are cleaned up.

## Upgrade

- Prepare the new release set, then activate it the same way. The previous release set stays active if any step fails.
- Data changes follow the [version-impact policy](version-impact-policy.md), using the explicit add, migrate, switch and retire steps.

## Uninstallation

**States.** An installation moves from active, to draining, to removed. While draining, callbacks for work already running are honoured, and no new work starts. The uninstaller either lets running work finish or cancels it under the cancellation policy in [09](../09-workflows-and-pipelines.md). Draining ends when no run remains.

**Registration ledger.** Each owning service records the registrations it creates for an installation, and can list and remove them. The uninstall report is the union of those lists. Uninstallation is complete when nothing remains except the items the uninstaller chose to keep.

The registrations covered are:
- Kestra flows, triggers, namespace files, key-value entries and execution storage, purged according to retention and legal hold;
- execution grants and connection-instance grants;
- interface operations, public addresses and incoming-message routes;
- search documents;
- pending outbox entries and start intents, which are marked refused;
- form drafts;
- record-sharing grants, which are revoked with notice;
- agent (MCP) grant scopes and tool bundles;
- the default-application setting;
- custom component bundles and assets that no other installation references;
- cached runtime bundles;
- permission registrations (the Access version increments).

**Data choice.** The uninstaller chooses one of:
- keep the records detached and restorable;
- export them and then delete them;
- delete them after the organisation's retention grace period.

Deletion applies only to record types that no other active installation binds. A legal hold always blocks deletion. Extension-field values follow the data choice, and columns with shared lineage are never dropped.

**Role assignments.** Assignments of the package's role templates are either ended, or kept but suspended until they are accepted again.

**Refusals.** The platform refuses:
- uninstalling a module while an active installation depends on it;
- uninstalling a system application;
- any uninstall that would leave the organisation's steward without a working way to manage access.

**Report.** Uninstallation produces an uninstall report and records it in Activity.

## Caching

**What is cached.** Prepare builds one runtime bundle per installation revision. The bundle holds:
- compiled pages and navigation;
- compiled flows and their trigger index;
- theme tokens;
- component registry entries, including custom component contracts and bundle addresses;
- the access plan, which holds declared permission requirements only;
- the tool bundle.

The bundle is an index plus parts of under 1 MB each, stored in Postgres.

**Keys.** Bundle keys are immutable: (organisation, installation, revision, bundle-format version). A format mismatch triggers a rebuild.

**How requests read it:**
- Each request reads the installation's active revision inside its request-context transaction, then reads bundle parts by the immutable key. A new revision is a new key, so there is no invalidation step.
- A request that names a stale revision receives a reload outcome.

**Cache tiers:**
- **Servers** keep bundle parts in a memory cache bounded by bytes. A shared runtime-cache tier is optional.
- **Custom component bundles and assets** are served from immutable, content-addressed URLs with long cache lifetimes.
- **Permission decisions** are never cached across people.
- **Query results** use the Access-version-keyed cache, except queries that use read-time computed fields.

## Building with an agent

Every builder operation is one typed, revision-checked operation, shared by the App Designer, the API and MCP. The operations cover:
- creating and changing modules, fields, relationships, pages, placements, flows and role templates;
- uploading component bundles;
- validating, and running a flow in test mode;
- previewing, including a **preview installation**:
  - it compiles the draft into an ephemeral candidate, never a release;
  - its record types get fresh preview storage identities;
  - durable tasks are simulated, and nothing is registered in Kestra;
  - only the previewing person and their agent can use it;
  - expiry removes its storage, records and registrations;
- publishing, installing, upgrading and uninstalling.

Validation returns located errors, so an agent can correct its draft and try again. An agent holds only the permissions of the person it acts for. Its MCP grant must include explicit build and install scopes.

## Acceptance examples

- **Custom component.** A package with a custom 3D component installs only for an installer holding `applications.manage` and `custom_code.manage`, with recent authentication.
  - The component renders through the bootstrap document, receives only the mapped fields, and has no session.
  - Its "shape changed" event runs at most one preview flow at a time; the last run uses the latest event.
- **Uninstall.** Uninstalling that package:
  - drains running work, then removes every registration in the ledger;
  - keeps or deletes records as chosen, never deleting a record type another installation binds;
  - produces a report. A later search finds no registration that belongs to the installation.
- **Agent building.** An agent acting for a person with the draft, release and applications permissions:
  - creates a module and a page;
  - fixes the located validation errors;
  - tests the page in a preview installation;
  - publishes, installs and opens it, without any code change.
- **Caching.** Opening an installed page reads no definition from the database once its bundle parts are in the server's memory cache.
- **Scripts.** A package that contains a script installs only for a Vortex super administrator. Its script runs as a Kestra script task that sees only its declared inputs and the callback key.
