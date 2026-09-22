import "server-only";

import { platformIdSchema, type DefinitionRuleFailure } from "@vortex/contracts";
import { createLocatedFailure } from "./errors";
import type {
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export function validatePublicPlatformAssets(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
  options?: ThemeResolutionOptions | undefined,
): { failures: ThemeValidationFailure[]; ruleFailures: DefinitionRuleFailure[] } {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  const addFailure = (params: {
    code: string;
    ruleCode?: string;
    family?: "invalid_value" | "unsafe_content" | "broken_reference";
    message: string;
    tokenKey?: string;
  }) => {
    const located = createLocatedFailure({
      ...params,
      documentKey: options?.documentKey,
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  const approvedSet =
    options?.approvedAssetIds !== undefined
      ? new Set(options.approvedAssetIds)
      : undefined;
  const publicSet =
    options?.publicAssetIds !== undefined
      ? new Set(options.publicAssetIds)
      : undefined;

  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token === undefined) continue;
    if (token.kind !== "asset") continue;

    // 1. Validate asset ID format
    const parsedId = platformIdSchema.safeParse(token.assetId);
    if (!parsedId.success) {
      addFailure({
        code: "INVALID_ASSET_IDENTIFIER",
        family: "invalid_value",
        message: `Asset token "${key}" references invalid platform asset identifier: "${token.assetId}"`,
        tokenKey: key,
      });
      continue;
    }

    // Approval and public visibility are separate positive facts. Absence from a
    // deny-list cannot prove either one, so asset-bearing themes fail closed when
    // the trusted caller did not provide both exact evidence sets.
    if (approvedSet === undefined) {
      addFailure({
        code: "ASSET_APPROVAL_UNVERIFIED",
        family: "unsafe_content",
        message: `Asset token "${key}" cannot be resolved without exact platform approval evidence for "${token.assetId}"`,
        tokenKey: key,
      });
    } else if (!approvedSet.has(token.assetId)) {
      addFailure({
        code: "UNAPPROVED_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references unapproved asset identifier: "${token.assetId}"`,
        tokenKey: key,
      });
    }

    if (publicSet === undefined) {
      addFailure({
        code: "ASSET_VISIBILITY_UNVERIFIED",
        family: "unsafe_content",
        message: `Asset token "${key}" cannot be resolved without exact public-visibility evidence for "${token.assetId}"`,
        tokenKey: key,
      });
    } else if (!publicSet.has(token.assetId)) {
      addFailure({
        code: "PRIVATE_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references non-public asset identifier "${token.assetId}". Only public platform assets may be referenced by themes.`,
        tokenKey: key,
      });
    }
  }

  return { failures, ruleFailures };
}
