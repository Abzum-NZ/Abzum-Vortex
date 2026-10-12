import { canonicalJson, type ConditionNode } from "@vortex/platform/schema";
import type { ModuleBeforeSaveConditionDraftContext } from "@web/platform-server";
import type { StudioConditionControlsContext } from "@vortex/ui/studio";

export const moduleBeforeSaveConditionControlsContext = (
  context: ModuleBeforeSaveConditionDraftContext,
): StudioConditionControlsContext => ({
  allowedOperands: context.fields.map(({ field }) => ({
    operand: { source: "field" as const, fieldId: field.fieldId },
    field, label: field.label, role: "current_field" as const,
  })),
  declaredFieldIds: context.fields.map(({ field }) => field.fieldId),
  parameterDeclarations: [], allowLiteralValues: true,
  allowedOperators: ["equals", "not_equals", "less_than", "less_than_or_equal",
    "greater_than", "greater_than_or_equal", "contains", "is_empty", "is_not_empty"],
});
export const sameModuleBeforeSaveCondition = (left: ConditionNode | null, right: ConditionNode | null): boolean =>
  canonicalJson(left) === canonicalJson(right);
