import type { DefinitionRuleFailure, DefinitionValidationLocation } from "../../schema";
import type { DefinitionSetValidationContext } from "./context";
import { array, failure, object } from "./helpers";

export const runtimeSupportRuleCodes = [
  "vortex.definition.public_page_not_supported",
  "vortex.definition.public_address_not_supported",
  "vortex.definition.token_authentication_not_supported",
  "vortex.definition.incoming_message_not_supported",
  "vortex.definition.rate_limit_not_supported",
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
    for (const page of array(content.pages)) {
      const component = { kind: "page" as const, key: String(page.key) };
      if (page.type === "public")
        refuse(
          "vortex.definition.public_page_not_supported",
          component,
          "Pages cannot yet open without sign-in. Remove the public page or use a signed-in page before publishing.",
        );
      if (page.rateLimitPerMinute !== undefined)
        refuse(
          "vortex.definition.rate_limit_not_supported",
          component,
          "Request limits per minute are not yet enforced. Remove the page's rate limit declaration before publishing.",
        );
    }
    for (const address of array(content.publicAddresses)) {
      const component = { kind: "setting" as const, key: "public_addresses" };
      refuse(
        "vortex.definition.public_address_not_supported",
        component,
        "Public web addresses are not yet served. Remove the public address before publishing.",
      );
      if (address.rateLimitPerMinute !== undefined)
        refuse(
          "vortex.definition.rate_limit_not_supported",
          component,
          "Request limits per minute are not yet enforced. Remove the public address's rate limit declaration before publishing.",
        );
    }
    for (const definition of array(content.interfaces)) {
      for (const operation of array(definition.operations)) {
        const component = { kind: "interface" as const, key: String(operation.key) };
        if (["organization_token", "partner_token"].includes(String(operation.authentication)))
          refuse(
            "vortex.definition.token_authentication_not_supported",
            component,
            "Interface operations cannot yet authenticate with organization or partner tokens. Remove the token-authenticated operation before publishing.",
          );
        if (operation.rateLimitPerMinute !== undefined)
          refuse(
            "vortex.definition.rate_limit_not_supported",
            component,
            "Request limits per minute are not yet enforced. Remove the interface operation's rate limit declaration before publishing.",
          );
      }
    }
  }
  return failures;
}
