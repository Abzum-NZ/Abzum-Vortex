import type {
  DefinitionRuleFailure,
  DefinitionValidationLocation,
} from "../../catalogue/validation-errors";
import type { DefinitionSetValidationContext } from "./context";
import { array, failure, object } from "./helpers";

export const runtimeSupportRuleCodes = [
  "vortex.definition.public_page_not_supported",
  "vortex.definition.public_address_not_supported",
  "vortex.definition.interface_operation_not_supported",
  "vortex.definition.incoming_message_not_supported",
] as const;

/** Publication promises only behaviour that the platform can serve and enforce. */
export function runtimeSupportRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs) {
    if (output.kind !== "application" && output.kind !== "module") continue;
    const content = object(object(output.canonical).content);
    const refuse = (
      ruleCode: (typeof runtimeSupportRuleCodes)[number],
      component: DefinitionValidationLocation["segments"][number],
      sentence: string,
    ) => {
      failures.push(
        failure(
          output,
          ruleCode,
          "unsupported_choice",
          component,
          "definition_runtime_not_supported",
          sentence,
        ),
      );
    };
    for (const flow of array(content.flows)) {
      if (array(flow.triggers).some((trigger) => trigger.type === "IncomingMessage"))
        refuse(
          "vortex.definition.incoming_message_not_supported",
          { kind: "flow", key: String(flow.key) },
          "Flows cannot yet start when an external message arrives. Remove the incoming message trigger before publishing.",
        );
    }
    if (output.kind !== "application") continue;
    // Each refused declaration requires its own per-minute limit, so refusing the declaration
    // also refuses the limit that nothing would enforce.
    for (const page of array(content.pages)) {
      if (page.type === "public")
        refuse(
          "vortex.definition.public_page_not_supported",
          { kind: "page", key: String(page.key) },
          "Pages cannot yet open without sign-in. Remove the public page or use a signed-in page before publishing.",
        );
    }
    if (array(content.publicAddresses).length > 0)
      refuse(
        "vortex.definition.public_address_not_supported",
        { kind: "setting", key: "public_addresses" },
        "Public web addresses are not yet served. Remove the public addresses before publishing.",
      );
    for (const definition of array(content.interfaces)) {
      for (const operation of array(definition.operations))
        refuse(
          "vortex.definition.interface_operation_not_supported",
          { kind: "interface", key: String(operation.key) },
          "Interface operations cannot yet be called from outside Vortex. Remove the interface operation before publishing.",
        );
    }
  }
  return failures;
}
