import {
  type DefinitionCompilationOutput,
  type DefinitionCompilationRequest,
  type ApplicationCompilationRequest,
  type ModuleCompilationRequest,
  type DefinitionSourceDocument,
  type ApplicationSourceDocument,
  type ModuleSourceDocument,
  type PlatformBlockRelease,
  applicationSourceDocumentSchema,
  moduleSourceDocumentSchema,
  definitionSourceDocumentSchema,
  type DefinitionValidationLocation,
  type DefinitionRuleFailure,
  type PublishedDefinitionHistory,
  type DefinitionPublicationHistoryEvidence,
  moduleDraftSchema,
  applicationDraftSchema,
  connectionTypeSchema,
} from "../../schema";
import { IMMUTABLE_PLATFORM_BLOCK_CATALOGUE } from "../application-composition-catalogue";
import type { z } from "zod";
import type { PlatformPermissionSource } from "../../access/platform-permissions";
import { createContractValueWalker } from "../contract-value-walker";

export type JsonObject = Record<string, unknown>;

export type Output = DefinitionCompilationOutput;

export type PublicationCompilationRequest =
  DefinitionCompilationRequest | ApplicationCompilationRequest | ModuleCompilationRequest;

export type DefinitionPath = readonly (string | number)[];

type EditSaveSource = DefinitionSourceDocument | ApplicationSourceDocument | ModuleSourceDocument;

/** Registered platform block releases by exact identity; the one source of supported events. */
export const registeredBlockReleases: ReadonlyMap<string, PlatformBlockRelease> = new Map(
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE.releases.map((release) => [
    `${release.blockId}:${release.releaseVersion}`,
    release,
  ]),
);

export const isApplicationSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "application";

export const isModuleSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "module";

export const parseEditSaveSource = (
  source: unknown,
):
  | Readonly<{
      success: true;
      data: EditSaveSource;
      schema: z.core.$ZodType;
    }>
  | Readonly<{ success: false; error: z.ZodError }> => {
  const schema = isApplicationSource(source)
    ? applicationSourceDocumentSchema
    : isModuleSource(source)
      ? moduleSourceDocumentSchema
      : definitionSourceDocumentSchema;
  const parsed = schema.safeParse(source);
  return parsed.success
    ? { success: true, data: parsed.data, schema }
    : { success: false, error: parsed.error };
};

export type DefinitionValidationStage = "edit_save" | "publish" | "install" | "runtime";

export type DefinitionSemanticRule = Readonly<{
  ruleId: string;
  emittedCodes: readonly string[];
  stage: DefinitionValidationStage;
  definitionKinds: readonly ("module" | "application" | "connection_type")[];
  requiredContext: readonly (
    "source" | "resolution_snapshot" | "compiled_set" | "prior_published_version"
  )[];
  safeLocationFamily: DefinitionValidationLocation["segments"][number]["kind"];
  run: (context: DefinitionSetValidationContext) => DefinitionRuleFailure[];
}>;

export type DefinitionSetValidationContext = Readonly<{
  /** The shipped platform permission catalogue the rules resolve platform keys against. */
  permissions: PlatformPermissionSource;
  requests: readonly PublicationCompilationRequest[];
  outputs: readonly Output[];
  rawSources?: readonly unknown[];
  dependencyOutputs?: readonly Output[];
  publishedHistories?: readonly PublishedDefinitionHistory[];
  publishedHistoryEvidence?: readonly DefinitionPublicationHistoryEvidence[];
}>;

/**
 * Work validateDefinitionSet derives once per call and hands to the rules that would otherwise
 * repeat it per rule. A rule invoked directly with a plain context derives its own, unchanged.
 */
export type PreparedValidationContext = DefinitionSetValidationContext &
  Readonly<{
    parsedSources?: readonly ReturnType<typeof parseEditSaveSource>[];
    walkCanonicalValues?: ReturnType<typeof createContractValueWalker>;
  }>;

/** The sources the edit-save rules judge, in the order their parsed results are held. */
export const editSaveSources = (context: DefinitionSetValidationContext): readonly unknown[] =>
  context.rawSources ?? context.requests.map((request) => request.source);

export const allValidationOutputs = (
  context: DefinitionSetValidationContext,
): readonly Output[] => [...(context.dependencyOutputs ?? []), ...context.outputs];

export const canonicalValueWalker = (context: DefinitionSetValidationContext) =>
  createContractValueWalker(
    allValidationOutputs(context).map((output) => ({
      schema:
        output.kind === "module"
          ? moduleDraftSchema
          : output.kind === "application"
            ? applicationDraftSchema
            : connectionTypeSchema,
      value: output.canonical,
    })),
  );
