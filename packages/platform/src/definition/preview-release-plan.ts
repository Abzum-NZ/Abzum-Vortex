import "server-only";

import type {
  DefinitionPublicationHistoryEvidence,
  ExactDefinitionDependency,
  SessionContext,
} from "../schema";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { applicationModuleKeys } from "./application-module-sources";
import type { ApplicationReleasePlan } from "./application-publication";
import { assertReleasable } from "./definition-publication-compilation";
import {
  refuse,
  type DefinitionDraftCandidate,
  type DefinitionPublicationReader,
  type DefinitionReleaseAppend,
  type OwnedModuleRoot,
} from "./definition-publication-contracts";

/** Exact mutable inputs checked again, under short shared locks, when the preview is applied. */
export type PreviewReleasePlan = Readonly<{
  accessVersion: number;
  application: Readonly<{
    rootId: string;
    draftRevision: number;
    sourceFingerprint: string;
    currentReleaseRevision: number | null;
  }>;
  ownedRoots: readonly OwnedModuleRoot[];
  usedRoots: readonly Readonly<{ rootId: string; currentReleaseRevision: number }>[];
  releases: readonly Readonly<{ release: unknown; dependencies: readonly unknown[] }>[];
}>;

const dependencyReference = (dependency: ExactDefinitionDependency): string => {
  switch (dependency.kind) {
    case "module":
    case "connection_type":
      return dependency.key;
    case "platform_block":
      return dependency.blockId;
    case "platform_theme":
      return dependency.catalogueThemeId;
    case "protected_operation": {
      const owner = dependency.operation.owner;
      return `${owner.kind}:${
        owner.kind === "application"
          ? owner.applicationRootId
          : owner.kind === "module"
            ? owner.moduleRootId
            : owner.serviceId
      }:${dependency.operation.operationId}`;
    }
    case "application_flow_node":
      return `${dependency.applicationRootId}:${dependency.flowId}:${dependency.nodeId}`;
    case "application_flow":
      return `${dependency.applicationRootId}:${dependency.flowId}`;
    case "application_query":
      return `${dependency.applicationRootId}:${dependency.queryId}`;
    case "module_query":
      return `${dependency.moduleRootId}:${dependency.queryId}`;
    case "application_form":
      return `${dependency.applicationRootId}:${dependency.formId}`;
    case "application_workflow":
      return `${dependency.applicationRootId}:${dependency.workflowId}`;
    case "application_action":
      return `${dependency.applicationRootId}:${dependency.actionId}`;
  }
};

/** Project the canonical release plan into the existing private runtime row contract. */
const previewRows = (append: DefinitionReleaseAppend, context: SessionContext) => {
  const { draft, compilationOutput: output } = append;
  const content = output.canonical.content;
  const application = output.kind === "application" ? output.canonical.content : undefined;
  return {
    release: {
      root_id: draft.rootId,
      release_revision: draft.draftRevision,
      release_version: append.assignedVersion,
      authored_source: draft.source,
      authored_source_fingerprint: draft.sourceFingerprint,
      source_contract_version: draft.sourceContractVersion,
      compilation_output: output,
      resolution_snapshot: append.resolutionSnapshot,
      content_fingerprint: output.artifact.contentFingerprint,
      resolution_fingerprint: output.resolutionFingerprint,
      validation_contract_version: append.validationContractVersion,
      impact_reasons: append.reasons,
      release_note: append.releaseNote,
      published_at: context.issuedAt,
      published_by:
        context.callerKind === "human"
          ? context.organizationAccountId
          : context.callerKind === "system"
            ? context.systemActorId
            : refuse("DEFINITION_PUBLICATION_AUTHORITY_UNAVAILABLE"),
      application_address:
        application === undefined
          ? null
          : {
              kind: output.kind,
              name: application.name,
              icon: application.icon,
              homePageId: application.homePageId,
              pages: application.pages.map(({ pageId, key, accessPermissionKey }) => ({
                pageId,
                key,
                accessPermissionKey,
              })),
              roles: application.roles.map(({ roleId, key, homePageId }) => ({
                roleId,
                key,
                homePageId,
              })),
            },
      application_experience:
        application === undefined
          ? null
          : {
              experiences: application.experiences ?? [],
              resolvedExperiences: (application.experiences ?? []).map((experience) => ({
                state: experience.state,
                page: application.pages.find((page) => page.pageId === experience.pageId),
              })),
              shells: application.shells,
              theme: application.theme,
            },
      record_content: Object.fromEntries(
        Object.entries(content).filter(([key]) =>
          ["recordTypes", "permissions", "rules", "actions", "events"].includes(key),
        ),
      ),
    },
    dependencies: append.dependencyManifest.map((dependency) => ({
      root_id: draft.rootId,
      release_revision: draft.draftRevision,
      dependency_kind: dependency.kind,
      dependency_reference: dependencyReference(dependency),
      dependency_version: dependency.releaseVersion,
      dependency_content_fingerprint: dependency.contentFingerprint,
      target_root_id: dependency.kind === "module" ? dependency.rootId : null,
      target_release_revision: dependency.kind === "module" ? dependency.releaseRevision : null,
      catalogue_item_id:
        dependency.kind === "connection_type"
          ? dependency.rootId
          : dependency.kind === "platform_block"
            ? dependency.blockId
            : null,
      dependency_entry: ["module", "connection_type", "platform_block", "platform_theme"].includes(
        dependency.kind,
      )
        ? null
        : dependency,
    })),
  };
};

/**
 * No release writes or write locks: preview releases the revision's one compile, `compile`, which
 * the builder has usually produced already, judged once more as a release against the published
 * history.
 */
export const planApplicationPreview = async (
  context: SessionContext,
  snapshot: DefinitionPublicationReader,
  candidate: DefinitionDraftCandidate,
  permissions: PlatformPermissionSource,
  compile: () => Promise<
    Readonly<{
      releasePlan: ApplicationReleasePlan;
      historyEvidence: DefinitionPublicationHistoryEvidence;
    }>
  >,
): Promise<PreviewReleasePlan> => {
  const ownedRoots = await snapshot.readOwnedModuleRoots(String(candidate.draft.rootId));
  const source = candidate.draft.source;
  if (source.kind !== "application") return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const application = {
    rootId: candidate.draft.rootId,
    draftRevision: candidate.draft.draftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    currentReleaseRevision: candidate.draft.publishedRevision ?? null,
  };
  // A released draft already has a validated immutable release and exact pins. Reuse it;
  // publication's new-revision comparison deliberately refuses republishing that revision.
  if (candidate.draft.publishedRevision === candidate.draft.draftRevision)
    return {
      accessVersion: context.accessVersion,
      application,
      ownedRoots,
      usedRoots: [],
      releases: [],
    };
  const inlineKeys = new Set(source.body.modules.map((source) => source.key));
  const usedKeys = applicationModuleKeys(source).filter((key) => !inlineKeys.has(key));
  const usedPages = await snapshot.readModuleReleaseAnchors(
    candidate.draft.organizationId,
    usedKeys,
  );
  const usedRoots = usedPages.map((page) => {
    if (page.rootId === null || page.anchorReleaseRevision === null)
      return refuse("DEFINITION_DEPENDENCY_MISSING");
    return { rootId: page.rootId, currentReleaseRevision: page.anchorReleaseRevision };
  });
  const { releasePlan: compiled, historyEvidence } = await compile();
  assertReleasable(compiled, historyEvidence, permissions);
  return {
    accessVersion: context.accessVersion,
    application,
    ownedRoots,
    usedRoots,
    releases: [
      ...compiled.modules.map((module) => previewRows(module.append, context)),
      previewRows(
        {
          draft: candidate.draft,
          compilationOutput: compiled.output,
          assignedVersion: compiled.output.artifact.exactVersion,
          reasons: [],
          dependencyManifest: compiled.manifest,
          resolutionSnapshot: compiled.resolution,
          validationContractVersion: compiled.output.validationContractVersion,
          releaseNote: "Compiled for preview",
        },
        context,
      ),
    ],
  };
};
