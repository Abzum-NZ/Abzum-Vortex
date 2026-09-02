import { z } from "zod";
import {
  applicationDraftSchema,
  publishedApplicationDefinitionSchema,
} from "./application-contracts";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  platformIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import { moduleDraftSchema, publishedModuleDefinitionSchema } from "./module-contracts";

export const versionImpactSchema = z.enum(["patch", "minor", "major"]);
export const versionImpactPolicyVersion = "1.0.0" as const;
export const stableDefinitionReleaseVersionSchema = semanticVersionSchema.refine(
  (value) => !value.includes("-") && !value.includes("+"),
  "Published definition versions must be stable major.minor.patch versions",
);

export const versionImpactReasonCodes = [
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
] as const;
export const versionImpactReasonCodeSchema = z.enum(versionImpactReasonCodes);

export const versionImpactComponentKinds = [
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
  "sharing_condition",
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
] as const;
export const versionImpactComponentKindSchema = z.enum(versionImpactComponentKinds);

export const versionImpactProperties = [
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
] as const;
export const versionImpactPropertySchema = z.enum(versionImpactProperties);

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

const textOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const optionRank = <Value extends string>(options: readonly Value[], value: Value): number =>
  options.indexOf(value);
const compareReasonOrder = (
  left: z.infer<typeof versionImpactReasonSchema>,
  right: z.infer<typeof versionImpactReasonSchema>,
): number => {
  const severity = { patch: 0, minor: 1, major: 2 } as const;
  return (
    severity[right.impact] - severity[left.impact] ||
    optionRank(versionImpactComponentKinds, left.location.componentKind) -
      optionRank(versionImpactComponentKinds, right.location.componentKind) ||
    textOrder(left.location.componentId ?? "", right.location.componentId ?? "") ||
    optionRank(versionImpactProperties, left.location.property) -
      optionRank(versionImpactProperties, right.location.property) ||
    optionRank(versionImpactReasonCodes, left.code) -
      optionRank(versionImpactReasonCodes, right.code)
  );
};

const nextStableVersion = (
  currentVersion: string,
  impact: z.infer<typeof versionImpactSchema>,
): string => {
  const [major, minor, patch] = currentVersion.split(".").map((segment) => BigInt(segment));
  if (major === undefined || minor === undefined || patch === undefined)
    throw new TypeError("A stable version must contain three segments");
  return impact === "patch"
    ? `${major}.${minor}.${patch + 1n}`
    : impact === "minor"
      ? `${major}.${minor + 1n}.0`
      : `${major + 1n}.0.0`;
};

export const definitionVersionSubjectSchema = z.discriminatedUnion("definitionKind", [
  z.object({ definitionKind: z.literal("module"), rootId: moduleRootIdSchema }).strict(),
  z.object({ definitionKind: z.literal("application"), rootId: applicationRootIdSchema }).strict(),
]);

export const definitionVersionImpactFailureCodeSchema = z.enum([
  "invalid_request",
  "invalid_history",
  "root_mismatch",
  "content_fingerprint_mismatch",
  "unresolved_candidate",
  "ambiguous_component_identity",
  "no_release_to_confirm",
  "confirmation_mismatch",
]);

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
  subject: definitionVersionSubjectSchema,
  comparisonFingerprint: fingerprintSchema,
};

export const noDefinitionChangeResultSchema = z
  .object({
    ...resultCommon,
    outcome: z.literal("no_change"),
    currentVersion: stableDefinitionReleaseVersionSchema,
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
    currentVersion: stableDefinitionReleaseVersionSchema,
    impact: versionImpactSchema,
    assignedVersion: stableDefinitionReleaseVersionSchema,
    reasons: z.array(versionImpactReasonSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ranks = { patch: 0, minor: 1, major: 2 } as const;
    const highest = value.reasons.reduce(
      (result, reason) => (ranks[reason.impact] > ranks[result] ? reason.impact : result),
      "patch" as z.infer<typeof versionImpactSchema>,
    );
    if (highest !== value.impact)
      context.addIssue({
        code: "custom",
        path: ["impact"],
        message: "Release impact must equal the highest reason impact",
      });
    if (value.assignedVersion !== nextStableVersion(value.currentVersion, value.impact))
      context.addIssue({
        code: "custom",
        path: ["assignedVersion"],
        message: "Assigned version must be the minimum next version for the release impact",
      });
    const keys = value.reasons.map((reason) => JSON.stringify(reason));
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Release reasons must not be duplicated",
      });
    for (let index = 1; index < value.reasons.length; index += 1)
      if (compareReasonOrder(value.reasons[index - 1]!, value.reasons[index]!) > 0) {
        context.addIssue({
          code: "custom",
          path: ["reasons", index],
          message: "Release reasons must use the governed deterministic order",
        });
        break;
      }
  });

export const definitionVersionImpactResultSchema = z.discriminatedUnion("outcome", [
  noDefinitionChangeResultSchema,
  initialDefinitionReleaseResultSchema,
  requiredDefinitionReleaseResultSchema,
]);

export const definitionVersionConfirmationSchema = z
  .object({
    subject: definitionVersionSubjectSchema,
    comparisonFingerprint: fingerprintSchema,
    assignedVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();

export type VersionImpact = z.infer<typeof versionImpactSchema>;
export type VersionImpactReason = z.infer<typeof versionImpactReasonSchema>;
export type DefinitionVersionSubject = z.infer<typeof definitionVersionSubjectSchema>;
export type DefinitionVersionImpactFailureCode = z.infer<
  typeof definitionVersionImpactFailureCodeSchema
>;
export type DefinitionVersionImpactRequest = z.infer<typeof definitionVersionImpactRequestSchema>;
export type DefinitionVersionImpactResult = z.infer<typeof definitionVersionImpactResultSchema>;
export type DefinitionVersionConfirmation = z.infer<typeof definitionVersionConfirmationSchema>;
