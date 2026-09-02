import { z } from "zod";
import {
  applicationDraftSchema,
  publishedApplicationDefinitionSchema,
} from "./application-contracts";
import { definitionKindSchema } from "./definitions";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  platformIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import { moduleDraftSchema, publishedModuleDefinitionSchema } from "./module-contracts";

export const versionImpactSchema = z.enum(["patch", "minor", "major"]);

export const versionImpactReasonCodeSchema = z.enum([
  "definition_text_changed",
  "presentation_changed",
  "component_added",
  "required_component_added",
  "component_removed",
  "component_identity_changed",
  "component_key_changed",
  "meaningful_order_changed",
  "constraint_widened",
  "constraint_narrowed",
  "storage_contract_changed",
  "ownership_changed",
  "permission_changed",
  "public_contract_changed",
  "dependency_requirement_changed",
  "existing_behavior_changed",
]);

export const versionImpactComponentKindSchema = z.enum([
  "module",
  "application",
  "dependency",
  "record_type",
  "field",
  "relationship",
  "action",
  "action_input",
  "event",
  "rule",
  "extension_point",
  "module_binding",
  "navigation_item",
  "page",
  "page_block",
  "role",
  "permission",
  "query",
  "block_registration",
  "pipeline",
  "pipeline_stage",
  "workflow",
  "workflow_node",
  "connection_binding",
  "interface",
  "public_address",
  "theme",
]);

export const versionImpactPropertySchema = z.enum([
  "definition",
  "identity",
  "key",
  "name",
  "description",
  "order",
  "configuration",
  "constraint",
  "required",
  "storage",
  "ownership",
  "permission",
  "visibility",
  "behavior",
  "version_requirement",
  "address",
  "theme",
]);

export const versionImpactLocationSchema = z
  .object({
    componentKind: versionImpactComponentKindSchema,
    componentId: platformIdSchema.optional(),
    property: versionImpactPropertySchema,
  })
  .strict();

export const versionImpactReasonSchema = z
  .object({
    impact: versionImpactSchema,
    code: versionImpactReasonCodeSchema,
    location: versionImpactLocationSchema,
  })
  .strict();

const historyLimit = 10_000;

export const moduleVersionImpactRequestSchema = z
  .object({
    kind: z.literal("module"),
    history: z.array(publishedModuleDefinitionSchema).max(historyLimit),
    candidate: moduleDraftSchema,
  })
  .strict();

export const applicationVersionImpactRequestSchema = z
  .object({
    kind: z.literal("application"),
    history: z.array(publishedApplicationDefinitionSchema).max(historyLimit),
    candidate: applicationDraftSchema,
  })
  .strict();

export const definitionVersionImpactRequestSchema = z.discriminatedUnion("kind", [
  moduleVersionImpactRequestSchema,
  applicationVersionImpactRequestSchema,
]);

const resultCommon = {
  definitionKind: definitionKindSchema,
  comparisonFingerprint: fingerprintSchema,
};

export const noDefinitionChangeResultSchema = z
  .object({
    ...resultCommon,
    outcome: z.literal("no_change"),
    currentVersion: semanticVersionSchema,
    reasons: z.array(versionImpactReasonSchema).max(0),
  })
  .strict();

export const initialDefinitionReleaseResultSchema = z
  .object({
    ...resultCommon,
    outcome: z.literal("initial_release"),
    assignedVersion: z.literal("1.0.0"),
    reasons: z.array(versionImpactReasonSchema).max(0),
  })
  .strict();

export const requiredDefinitionReleaseResultSchema = z
  .object({
    ...resultCommon,
    outcome: z.literal("release_required"),
    currentVersion: semanticVersionSchema,
    impact: versionImpactSchema,
    assignedVersion: semanticVersionSchema,
    reasons: z.array(versionImpactReasonSchema).min(1),
  })
  .strict();

export const definitionVersionImpactResultSchema = z.discriminatedUnion("outcome", [
  noDefinitionChangeResultSchema,
  initialDefinitionReleaseResultSchema,
  requiredDefinitionReleaseResultSchema,
]);

export const definitionVersionConfirmationSchema = z.discriminatedUnion("definitionKind", [
  z
    .object({
      definitionKind: z.literal("module"),
      rootId: moduleRootIdSchema,
      comparisonFingerprint: fingerprintSchema,
      assignedVersion: semanticVersionSchema,
    })
    .strict(),
  z
    .object({
      definitionKind: z.literal("application"),
      rootId: applicationRootIdSchema,
      comparisonFingerprint: fingerprintSchema,
      assignedVersion: semanticVersionSchema,
    })
    .strict(),
]);

const maximumSafeVersionSegment = BigInt(Number.MAX_SAFE_INTEGER);

const parseVersionCore = (version: string): [bigint, bigint, bigint] => {
  const parsed = semanticVersionSchema.parse(version);
  const core = parsed.split(/[+-]/u, 1)[0];
  const segments = core?.split(".");
  if (!segments || segments.length !== 3) throw new RangeError("Invalid semantic version core");
  const values = segments.map((segment) => BigInt(segment));
  if (values.some((segment) => segment > maximumSafeVersionSegment))
    throw new RangeError("Published version segment exceeds the supported range");
  return values as [bigint, bigint, bigint];
};

export const assignNextDefinitionVersion = (
  currentVersion: string,
  impact: z.infer<typeof versionImpactSchema>,
): string => {
  const [major, minor, patch] = parseVersionCore(currentVersion);
  const next =
    impact === "patch"
      ? [major, minor, patch + 1n]
      : impact === "minor"
        ? [major, minor + 1n, 0n]
        : [major + 1n, 0n, 0n];
  if (next.some((segment) => segment > maximumSafeVersionSegment))
    throw new RangeError("Assigned version segment exceeds the supported range");
  return semanticVersionSchema.parse(next.join("."));
};

export type VersionImpact = z.infer<typeof versionImpactSchema>;
export type VersionImpactReason = z.infer<typeof versionImpactReasonSchema>;
export type DefinitionVersionImpactRequest = z.infer<typeof definitionVersionImpactRequestSchema>;
export type DefinitionVersionImpactResult = z.infer<typeof definitionVersionImpactResultSchema>;
export type DefinitionVersionConfirmation = z.infer<typeof definitionVersionConfirmationSchema>;
