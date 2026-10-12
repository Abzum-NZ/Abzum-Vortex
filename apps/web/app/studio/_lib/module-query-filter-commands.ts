import { canonicalJson, type ConditionNode } from "@vortex/platform/schema";
import type { ModuleQueryFilterDraftContext } from "@web/platform-server";
import type { StudioConditionControlsContext } from "@vortex/ui/studio";
export const moduleQueryFilterControlsContext = (
  context: ModuleQueryFilterDraftContext,
): StudioConditionControlsContext => ({
  allowedOperands: [
    ...context.fields.map(({ field }) => ({
      operand: { source: "field" as const, fieldId: field.fieldId },
      field,
      label: field.label,
      role: "current_field" as const,
    })),
    ...context.parameters.map((parameter) => ({
      operand: { source: "parameter" as const, key: parameter.key },
      label: parameter.key,
      role: "declared_input" as const,
    })),
  ],
  declaredFieldIds: context.fields.map(({ field }) => field.fieldId),
  parameterDeclarations: context.parameters,
  allowLiteralValues: true,
});

export const sameModuleQueryFilter = (
  left: ConditionNode | null,
  right: ConditionNode | null,
): boolean => canonicalJson(left) === canonicalJson(right);
