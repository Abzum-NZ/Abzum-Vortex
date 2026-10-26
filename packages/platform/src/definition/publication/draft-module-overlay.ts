import "server-only";

import type { SessionContext } from "../../access/identity-access";
import type { OrganizationId } from "../../catalogue/identifiers";
import type { ModuleSourceDocument } from "../definition-source";
import {
  publishDefinitionResultSchema,
  type PublishDefinitionResult,
  type StoredDefinitionDraft,
} from "../definition-store-contracts";
import { moduleVersionImpactHistoryEntrySchema } from "../version-impact";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { extractStoredSourceIdentityRequirements } from "../source-identities";
import { derivedOwnedModuleRootId, derivedSourceIdentityId } from "../derived-definition-id";
import {
  refuse,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationReader,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ModuleReleasePageCursor,
  type OwnedModuleRoot,
  type ResolvableModuleRelease,
  type ResolvableModuleReleasePage,
} from "../definition-publication-contracts";

type IdentityAssignments = DefinitionPublicationCandidate["identities"];

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * The identities a Module source names: each recorded one keeps its identifier, and each one not
 * recorded yet gets the identifier the database will record for it.
 */
const identityAssignments = (
  rootId: string,
  source: ModuleSourceDocument,
  recorded: IdentityAssignments,
): IdentityAssignments => {
  const scoped = new Map<string, Set<string>>();
  const unscoped = new Map<string, Set<string>>();
  for (const identity of recorded) {
    for (const [index, parts] of [
      [scoped, [identity.scope, identity.kind, identity.componentOwner]],
      [unscoped, [identity.kind, identity.componentOwner]],
    ] as const) {
      const key = JSON.stringify(parts);
      let identifiers = index.get(key);
      if (identifiers === undefined) index.set(key, (identifiers = new Set()));
      identifiers.add(String(identity.identifier));
    }
  }
  const assignments: IdentityAssignments[number][] = [];
  for (const requirement of extractStoredSourceIdentityRequirements(source)) {
    const inScope = scoped.get(
      JSON.stringify([requirement.scope, requirement.kind, requirement.componentOwner]),
    );
    const anyScope = [
      ...(inScope ??
        unscoped.get(JSON.stringify([requirement.kind, requirement.componentOwner])) ??
        []),
    ];
    if (anyScope.length > 1) refuse("DEFINITION_COMPILATION_REFUSED");
    const identifier =
      requirement.kind === "root"
        ? rootId
        : (anyScope[0] ??
          derivedSourceIdentityId(
            rootId,
            requirement.ownerScope,
            requirement.kind,
            requirement.componentOwner,
          ));
    for (const alias of requirement.aliases)
      assignments.push({
        definitionKey: requirement.definitionKey,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias,
        identifier,
      } as IdentityAssignments[number]);
  }
  return assignments.sort(
    (left, right) =>
      compareText(left.scope, right.scope) ||
      compareText(left.kind, right.kind) ||
      compareText(left.alias, right.alias),
  );
};

/**
 * The publication of an Application draft's inline Modules, held in memory over the stored
 * definitions. It is the in-memory implementation of the publication transaction: the
 * publication's own steps stage, compile and release each inline Module against it exactly as
 * they do against the database, and the identities it derives for what is not yet recorded are
 * the ones the database will record. Nothing is written; a draft compile reads it and drops it.
 */
export const createDraftModuleOverlay = (
  storedReader: DefinitionPublicationReader,
  context: SessionContext,
  applicationDraft: StoredDefinitionDraft,
): DefinitionPublicationTransaction => {
  // One draft compile reads the stored definitions in one read transaction, so its owned roots, a
  // stored release page or a release read once are the same for the rest of the compile and are
  // read only once.
  const storedReads = new Map<string, Promise<unknown>>();
  const once = <Value>(parts: readonly unknown[], read: () => Promise<Value>): Promise<Value> => {
    const readKey = JSON.stringify(parts);
    const known = storedReads.get(readKey);
    if (known !== undefined) return known as Promise<Value>;
    const value = read();
    storedReads.set(readKey, value);
    return value;
  };
  const reader: DefinitionPublicationReader = {
    readCandidate: (rootId) =>
      once(["candidate", rootId.toLowerCase()], () => storedReader.readCandidate(rootId)),
    readDraftCandidate: (rootId) => storedReader.readDraftCandidate(rootId),
    isApplicationDraftCurrent: (candidate) => storedReader.isApplicationDraftCurrent(candidate),
    readModuleReleaseAnchors: (organizationId, keys) =>
      once(["anchors", organizationId, keys], () =>
        storedReader.readModuleReleaseAnchors(organizationId, keys),
      ),
    readOwnedModulePublication: (rootId) => storedReader.readOwnedModulePublication(rootId),
    readOwnedModuleRoots: (applicationRootId) =>
      once(["owned", String(applicationRootId).toLowerCase()], () =>
        storedReader.readOwnedModuleRoots(applicationRootId),
      ),
    readModuleReleasePage: (organizationId, moduleKey, cursor) =>
      once(["page", organizationId, moduleKey, cursor ?? null], () =>
        storedReader.readModuleReleasePage(organizationId, moduleKey, cursor),
      ),
    readModuleRelease: (organizationId, rootId, releaseRevision) =>
      once(["release", organizationId, String(rootId).toLowerCase(), releaseRevision], () =>
        storedReader.readModuleRelease(organizationId, rootId, releaseRevision),
      ),
    readModuleReleases: (organizationId, locators) =>
      storedReader.readModuleReleases(organizationId, locators),
  };
  const candidates = new Map<string, DefinitionPublicationCandidate>();
  const releasesByKey = new Map<string, ResolvableModuleRelease>();
  const storedAnchors = new Map<
    string,
    ResolvableModuleReleasePage["anchorReleaseRevision"] & number
  >();
  const key = (rootId: string) => rootId.toLowerCase();
  const actor = {
    at: applicationDraft.updatedAt,
    by: applicationDraft.updatedBy,
  };

  const stagedCandidate = (
    previous: DefinitionPublicationCandidate | undefined,
    rootId: string,
    source: ModuleSourceDocument,
    draftRevision: number,
  ): DefinitionPublicationCandidate => {
    const sourceFingerprint = fingerprintCanonicalValue(source);
    const draft = {
      kind: "module",
      rootId,
      key: source.key,
      organizationId: applicationDraft.organizationId,
      draftRevision,
      ...(previous?.draft.publishedRevision === undefined
        ? {}
        : { publishedRevision: previous.draft.publishedRevision }),
      sourceContractVersion: source.source_contract_version,
      sourceFingerprint,
      source,
      createdAt: previous?.draft.createdAt ?? actor.at,
      createdBy: previous?.draft.createdBy ?? actor.by,
      updatedAt: actor.at,
      updatedBy: actor.by,
    } as unknown as StoredDefinitionDraft;
    return {
      draft,
      identities: identityAssignments(rootId, source, previous?.identities ?? []),
      releaseHistory:
        previous?.releaseHistory ??
        ({
          kind: "module",
          definitionKey: source.key,
          rootId,
          anchorReleaseRevision: null,
          latestRelease: null,
        } as DefinitionPublicationCandidate["releaseHistory"]),
      savedConditionHistory: previous?.savedConditionHistory ?? [],
      latestPlatformPins: previous?.latestPlatformPins ?? [],
    };
  };

  const overlayRelease = (rootId: string): ResolvableModuleRelease | undefined =>
    [...releasesByKey.values()].find((release) => key(release.rootId) === key(rootId));

  const readModuleRelease: DefinitionPublicationReader["readModuleRelease"] = async (
    organizationId,
    rootId,
    releaseRevision,
  ) => {
    const held = overlayRelease(rootId);
    if (held !== undefined && held.releaseRevision === releaseRevision) return held;
    return reader.readModuleRelease(organizationId, rootId, releaseRevision);
  };

  const transaction: DefinitionPublicationTransaction = {
    isApplicationDraftCurrent: (candidate) => reader.isApplicationDraftCurrent(candidate),
    async readModuleReleaseAnchors(organizationId, keys) {
      const missing = keys.filter((key) => !releasesByKey.has(key));
      const stored = await reader.readModuleReleaseAnchors(organizationId, missing);
      let index = 0;
      return keys.map((key) => {
        const held = releasesByKey.get(key);
        return held === undefined
          ? stored[index++]!
          : {
              rootId: held.rootId,
              anchorReleaseRevision: held.releaseRevision,
            };
      });
    },
    async readCandidate(rootId) {
      return candidates.get(key(rootId)) ?? reader.readCandidate(rootId);
    },
    async lockCandidate(rootId) {
      return candidates.get(key(rootId)) ?? reader.readCandidate(rootId);
    },
    async readDraftCandidate(rootId) {
      const held = candidates.get(key(rootId));
      return held === undefined
        ? reader.readDraftCandidate(rootId)
        : {
            draft: held.draft,
            identities: held.identities,
            currentReleaseVersion:
              held.releaseHistory.latestRelease?.publication.releaseVersion ?? null,
          };
    },
    readOwnedModuleRoots: (applicationRootId) => reader.readOwnedModuleRoots(applicationRootId),
    readOwnedModulePublication: (rootId) => reader.readOwnedModulePublication(rootId),

    async readModuleReleasePage(
      organizationId: OrganizationId,
      moduleKey: string,
      cursor?: ModuleReleasePageCursor,
    ): Promise<ResolvableModuleReleasePage> {
      const held = releasesByKey.get(moduleKey);
      if (held === undefined)
        return reader.readModuleReleasePage(organizationId, moduleKey, cursor);
      // The held release is the newest of its root: it anchors every page and ends the last one.
      // A continuation goes on through the stored pages under their own anchor.
      const storedAnchor = storedAnchors.get(moduleKey);
      if (cursor !== undefined && storedAnchor === undefined)
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      const stored = await reader.readModuleReleasePage(
        organizationId,
        moduleKey,
        cursor === undefined ? undefined : { ...cursor, anchorReleaseRevision: storedAnchor! },
      );
      if (stored.rootId !== null && key(stored.rootId) !== key(held.rootId))
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      if (stored.anchorReleaseRevision !== null)
        storedAnchors.set(moduleKey, stored.anchorReleaseRevision);
      const last = stored.entries[stored.entries.length - 1]?.release.releaseRevision ?? null;
      return {
        rootId: held.rootId,
        anchorReleaseRevision: held.releaseRevision,
        entries:
          stored.nextAfterReleaseRevision === null
            ? [...stored.entries, { previousReleaseRevision: last, release: held }]
            : stored.entries,
        nextAfterReleaseRevision: stored.nextAfterReleaseRevision,
      };
    },
    readModuleRelease,
    async readModuleReleases(organizationId, locators) {
      const missing = locators.filter((locator) => {
        const held = overlayRelease(locator.rootId);
        return held === undefined || held.releaseRevision !== locator.releaseRevision;
      });
      const stored = await reader.readModuleReleases(organizationId, missing);
      let index = 0;
      return locators.map((locator) => {
        const held = overlayRelease(locator.rootId);
        return held !== undefined && held.releaseRevision === locator.releaseRevision
          ? held
          : stored[index++];
      });
    },

    async createOwnedModuleRoot(applicationRootId, source): Promise<OwnedModuleRoot> {
      const rootId = derivedOwnedModuleRootId(applicationRootId, source.key);
      const candidate = stagedCandidate(undefined, rootId, source, 1);
      candidates.set(key(rootId), candidate);
      return {
        rootId: rootId as OwnedModuleRoot["rootId"],
        key: source.key,
        draftRevision: 1 as OwnedModuleRoot["draftRevision"],
        currentReleaseRevision: null,
        sourceFingerprint: candidate.draft.sourceFingerprint,
      };
    },

    async stageOwnedModuleSource(root, source): Promise<OwnedModuleRoot> {
      const previous =
        candidates.get(key(root.rootId)) ?? (await reader.readCandidate(root.rootId));
      if (previous === undefined || previous.draft.draftRevision !== root.draftRevision)
        refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
      const draftRevision = root.draftRevision + 1;
      const candidate = stagedCandidate(previous, String(root.rootId), source, draftRevision);
      candidates.set(key(root.rootId), candidate);
      return {
        ...root,
        draftRevision: draftRevision as OwnedModuleRoot["draftRevision"],
        sourceFingerprint: candidate.draft.sourceFingerprint,
      };
    },

    async appendModuleRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
      const output = release.compilationOutput;
      if (release.draft.kind !== "module" || output.kind !== "module")
        return refuse("DEFINITION_COMPILATION_REFUSED");
      const moduleDependencies = release.dependencyManifest.filter(
        (dependency) => dependency.kind === "module",
      );
      const references = [];
      for (const dependency of moduleDependencies) {
        const target = await readModuleRelease(
          context.organizationId as OrganizationId,
          dependency.rootId,
          dependency.releaseRevision,
        );
        if (target === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
        references.push(target.published.publication);
      }
      const publication = {
        kind: "module" as const,
        rootId: release.draft.rootId,
        revision: release.draft.draftRevision,
        releaseVersion: release.assignedVersion,
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt: context.issuedAt,
        publishedBy: actor.by,
        validationContractVersion: release.validationContractVersion,
      };
      const published = moduleVersionImpactHistoryEntrySchema.safeParse({
        publication,
        content: output.canonical.content,
        dependencyManifest: references,
        releaseNote: release.releaseNote,
      });
      if (!published.success) return refuse("DEFINITION_COMPILATION_REFUSED");
      const held: ResolvableModuleRelease = {
        organizationId: release.draft.organizationId,
        key: release.draft.key,
        rootId: release.draft.rootId as ResolvableModuleRelease["rootId"],
        releaseRevision: release.draft.draftRevision,
        releaseVersion: release.assignedVersion as ResolvableModuleRelease["releaseVersion"],
        contentFingerprint: output.artifact.contentFingerprint,
        resolutionFingerprint: release.resolutionSnapshot.fingerprint,
        sourceFingerprint: release.draft.sourceFingerprint,
        published: published.data,
        compilationOutput: output,
        resolutionSnapshot: release.resolutionSnapshot,
      };
      releasesByKey.set(release.draft.key, held);
      return publishDefinitionResultSchema.parse({
        rootId: held.rootId,
        releaseRevision: held.releaseRevision,
        releaseVersion: held.releaseVersion,
        contentFingerprint: held.contentFingerprint,
        resolutionFingerprint: held.resolutionFingerprint,
        dependencyManifest: release.dependencyManifest,
        publishedAt: publication.publishedAt,
        publishedBy: publication.publishedBy,
      });
    },

    appendRelease: () => refuse("DEFINITION_COMPILATION_REFUSED"),
  };
  return transaction;
};
