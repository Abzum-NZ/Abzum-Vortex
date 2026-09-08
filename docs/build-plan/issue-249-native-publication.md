# Native application publication, persistence and readback

Task: [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249).
Preceding slice: [native draft storage](issue-249-native-draft-storage.md).
Specification: [page composition](../specification/appendices/page-builder-contracts.md).
Status: implementation and independent Sol review complete; normal Testing
delivery and exact hosted verification remain. The coordinated runtime and SQL
acceptance is recorded in the [publication evidence](../evidence/issue-249-native-publication.md).
This does not complete the remaining conversion and adapter work in #249.

## Outcome

Publish an exact V2 Application draft through the existing Definition publication transaction, persist its exact platform-block catalogue dependencies, read it through the existing consumer and history services, and restore either V1 or V2 authored source without changing any immutable historical row. A representation change in either direction is an explicit major release assigned from the latest release version.

This slice does not add a designer, conversion command, installation, new publication API, history store, counter, cache or approval mechanism.

## Preconditions

1. Native V2 source/canonical contracts, compiler, identity extraction and provenance are delivered.
2. Native homogeneous V2 comparison is delivered. This slice must implement the representation-transition path for both V1-to-V2 and restored-V1-after-V2 as forced major changes before publication is enabled.
3. The preceding native-draft-storage slice has enabled exact V2 stored drafts and permanent `shell` / `shell_content_slot` identities while keeping V2 publication closed.
4. The immutable V2 platform-block/theme catalogue remains the sole catalogue source. No durable duplicate catalogue is introduced here.

## Contract changes

### Application releases

- In `contracts/src/application-contracts.ts`, retain the exact V1 published Application schema and add an explicitly selected V2 published Application schema using V2 canonical content.
- Select a published Application representation from its trusted outer `publication.validationContractVersion`. Do not infer it from nested content.
- Existing V1 canonical content and fingerprint inputs remain byte-identical.

### Compilation, history and dependency evidence

- In `contracts/src/definition-compilation-contracts.ts`:
  - include `applicationCompilationOutputV2Schema` in the existing compilation-output union;
  - allow one Application history to contain ordered V1 and V2 releases, each carrying its own exact validation version;
  - retain module and connection-type shapes unchanged.
- In `contracts/src/definition-store-contracts.ts`, add one exact dependency variant:

  ```text
  platform_block {
    blockId,
    releaseVersion,
    contentFingerprint,
    catalogueFingerprint
  }
  ```

- Its deterministic manifest subject is `platform_block:<blockId>`. Existing module, connection-type and platform-theme subjects are unchanged.
- Update consumer/history internal evidence schemas only where necessary to admit the version-selected V2 output and the platform-block manifest entry. Do not add a representation tag to canonical content or to fingerprint inputs.

## Runtime implementation

### Catalogue and dependency resolution

- Extend `runtime/definition/src/definition-publication-catalogue.ts` with an exact lookup over the already-materialized V2 platform-block catalogue by `blockId + releaseVersion`.
- In `runtime/definition/src/definition-publication.ts`:
  - select V1 or V2 compilation strictly from the stored Application source-contract version and its supported validation pair;
  - for V2, resolve every authored platform-block dependency against that exact immutable catalogue release;
  - verify block ID, stable version, content fingerprint and catalogue fingerprint;
  - retain current module, connection and theme resolution paths;
  - build one sorted manifest across all dependency kinds;
  - require one-to-one equality between the manifest, V2 canonical `platformBlockDependencies`, selected theme, resolved module/connection evidence and compiler provenance;
  - pass the exact selected validation version into the existing release append rather than hard-coding V1.
- Keep the existing prepare/recompute/confirm flow. Confirmation remains bound to the candidate root, draft revision, exact candidate content/resolution fingerprints, latest history and assigned version.

### Release integrity and repository

- In `runtime/definition/src/definition-release-integrity.ts`, select the Application output/canonical decoder by the trusted source/validation pair and validate:
  - root, organisation, definition key and assigned version;
  - canonical content fingerprint;
  - resolution-snapshot fingerprint and exact permanent identities;
  - complete dependency-manifest equality, including platform blocks;
  - exact catalogue evidence for the content used by the consumer.
- Validate exact source-to-canonical compiler provenance during compilation and
  publication. Do not transport authored source to a canonical-only consumer or
  recompile the application on every read merely to reproduce diagnostic provenance.
  Consumer output does not expose or use provenance as authority. Restore checks
  the exact authored source and identity evidence before creating an editable
  draft; subsequent publication recompiles it through the same validation path.
- In `runtime/definition/src/definition-publication-repository.ts`:
  - decode each Application release in mixed history using that release's stored validation version;
  - preserve revision/version ordering and the existing first-release `1.0.0` invariant;
  - never rewrite an earlier release or coerce its content to the candidate representation;
  - reuse the existing root/draft lock and atomic `append_release` call.

### Consumer reads

- In `runtime/definition/src/definition-consumer-read.ts`:
  - select V1 or V2 before decoding canonical/compilation payloads;
  - extend manifest parity to exact platform-block subjects and evidence;
  - verify each block dependency against the immutable platform catalogue supplied to the existing consumer service;
  - return the existing safe release envelope with the exact V1 or V2 canonical content and stored validation version.
- `runtime/definition/src/definition-consumer-read-repository.ts` remains the transport. Change it only if its result parser currently narrows compilation output to V1.

### History and restore

- In `runtime/definition/src/definition-history.ts`:
  - replace the V1-only restore-evidence constraint with exact version-pair selection;
  - verify V1 evidence with the existing V1 decoder and V2 evidence with the V2 decoder;
  - include platform-block catalogue verification for V2;
  - restore the selected release's exact authored source and original source-contract version into the one editable draft with existing restore provenance;
  - derive and verify the correct V1 or V2 identity requirements without allocating identities during restore.
- `runtime/definition/src/definition-history-repository.ts` continues using the existing atomic revision-checked restore operation.

## Additive database migration

Create one CLI-generated migration after the delivered native-draft-storage migration.

### Existing table representation

Reuse `vortex_definition.release_dependencies`:

- `dependency_kind = 'platform_block'`
- `dependency_reference = blockId::text`
- `dependency_version = releaseVersion`
- `dependency_content_fingerprint = contentFingerprint`
- `evidence_fingerprint = catalogueFingerprint`
- `catalogue_item_id = blockId`
- `target_root_id` and `target_release_revision` are null

Replace the closed kind, reference-shape and target-shape constraints to admit exactly this fourth form. Preserve all existing rows and constraints for module, connection type and platform theme.

### Existing functions to replace additively

- `vortex_definition.append_release`
  - validate the exact platform-block JSON key set;
  - reject nil/noncanonical block IDs, unstable versions and malformed fingerprints;
  - include block ID in duplicate-subject detection;
  - insert exactly one dependency row per supplied block;
  - return the exact platform-block manifest object;
  - preserve the existing draft/root locks, expected-history check, one release insert, dependency count check and root-pointer update transaction.
- Publication-candidate projections in the current publication migration chain:
  - serialize mixed history with each release's source/validation metadata and unchanged stored payload;
  - do not treat platform blocks as module release targets.
- `vortex_definition.read_consumer_release`
  - serialize platform-block dependencies with the exact four evidence fields.
- The history/restore evidence function from `20260904040758_definition_history_restore.sql`
  - serialize the same platform-block dependency evidence for integrity verification.

No new table, column, index, grant, RLS policy or public function is required. Existing private-table privileges and request-role operation grants remain unchanged.

Use same-signature function replacement, preserving each function's existing
security and configuration properties. PostgreSQL retains ownership and permissions
for replacement; it does not retain unspecified function properties automatically.
See [official CREATE FUNCTION guidance](https://www.postgresql.org/docs/current/sql-createfunction.html).

## Representation-transition rules

- V1 latest + V1 candidate: existing V1 comparator.
- V2 latest + V2 candidate: native V2 comparator.
- V1 latest + V2 candidate: forced major.
- V2 latest + exact restored V1 candidate: forced major.
- Unknown, missing or mismatched source/validation pair: refuse before decoding nested content.

The assigned version always advances from the latest stable release. Example: V1 `1.4.2` to V2 is `2.0.0`; restoring and publishing an older V1 source afterward is `3.0.0`. Restore does not itself publish or move the current release pointer.

## Implementation order

1. Widen exact contracts and add platform-block dependency evidence.
2. Add catalogue lookup and runtime dependency/manifest construction.
3. Extend release integrity and mixed-history materialization.
4. Add the single migration, keeping V2 append closed until all function replacements are present.
5. Enable the existing publication prepare/publish path for the exact V2 pair.
6. Enable version-selected consumer read and restore.
7. Run combined TypeScript and rollback-only SQL acceptance, including unchanged V1 suites.

Do not merge a state where `append_release` can store a platform-block row that consumer/history/restore cannot reproduce and verify.

## Decisive acceptance

### TypeScript

- Existing V1 preservation hashes and V1 publication/consumer/history tests remain unchanged.
- Prepare and confirm a V2 first release through the existing API; assigned version is `1.0.0` only when history is empty.
- Publish V2 after V1 under the same root; result is the next major with exact transition comparison evidence.
- Restore exact V1 after V2 and publish it as the next major.
- Homogeneous V2 follow-up uses native V2 comparison, not the transition rule.
- Missing, extra, duplicate or substituted platform-block dependency refuses.
- Wrong block version, content fingerprint or catalogue fingerprint refuses.
- Tampered V2 canonical content, used output, resolution or identity evidence
  refuses at the relevant storage/read boundary. Invalid source-to-canonical
  provenance refuses during compilation/publication, where that evidence is used.
- Stale confirmation/draft revision and concurrent root publication preserve existing refusal and atomicity.
- Consumer reads exact V1 and V2 revisions from one mixed history.
- Restore exact V1 and V2 authored bytes; wrong pair or tampered dependency evidence refuses before draft mutation.

### Rollback-only SQL

- Extend the existing `060_definition_publication_operations.test.sql`, `070_definition_consumer_reads.test.sql` and `080_definition_history_restore.test.sql` fixtures rather than creating a parallel harness.
- Prove one V2 release persists every platform block exactly once and returns an identical manifest.
- Prove duplicate/malformed block evidence rolls back release, dependency rows and root pointer together. Missing or substituted catalogue evidence is checked in the existing trusted runtime, not against an invented second database catalogue.
- Prove a V1 then V2 release shares one monotonic revision/version history and leaves the V1 row byte-identical.
- Prove exact V1 and V2 consumer readback.
- Prove restoring either representation preserves its original authored source/version and does not alter immutable releases or the current release pointer.
- Re-run the unchanged V1 publication, consumer and history assertions.

## Boundaries and ambiguity

- Installed/deployed Application adoption remains [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) / [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327).
- The explicit revision-checked V1-to-V2 conversion action and editor adapter follow this working publication path; they are not simulated here.
- Before conversion, complete the identified
  [placement compatibility gap](issue-249-placement-compatibility.md) so existing
  conditional visibility and explicit query bindings are not lost. This is a
  bounded follow-up, not richer binding execution or an extra publication gate.
- No business ambiguity remains: both exact representations are supported, both transitions are major, and restore returns exact historical authored source. The only implementation constraint is that platform-block persistence must be enabled atomically with all corresponding readback and integrity paths.

## Proportional integrity decision

Architect and independent Sol agreed that canonical-only reads must not gain raw
authored-source transport or per-read recompilation. Those additions would add
coupling and cost without addressing a demonstrated authority failure. The reader
verifies the immutable content, resolution, manifest and current catalogue it
actually consumes. Compiler provenance is verified where source is compiled for
publication. Restore does not activate anything; publishing the restored draft
repeats compilation. This clarifies acceptance ownership, not a bypass of
permissions, exact dependency checks or publication validation.
