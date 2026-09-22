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
  const unapprovedSet =
    options?.unapprovedAssetIds !== undefined
      ? new Set(options.unapprovedAssetIds)
      : undefined;
  const privateSet =
    options?.privateAssetIds !== undefined
      ? new Set(options.privateAssetIds)
      : undefined;

  for (const [key, token] of Object.entries(tokens)) {
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

    // 2. Validate approved / public status
    if (approvedSet !== undefined && !approvedSet.has(token.assetId)) {
      addFailure({
        code: "UNAPPROVED_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references unapproved asset identifier: "${token.assetId}"`,
        tokenKey: key,
      });
      continue;
    }

    if (unapprovedSet !== undefined && unapprovedSet.has(token.assetId)) {
      addFailure({
        code: "UNAPPROVED_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references explicitly unapproved asset identifier: "${token.assetId}"`,
        tokenKey: key,
      });
      continue;
    }

    if (privateSet !== undefined && privateSet.has(token.assetId)) {
      addFailure({
        code: "PRIVATE_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references private asset identifier "${token.assetId}". Only public platform assets may be referenced by themes.`,
        tokenKey: key,
      });
      continue;
    }

    if (options?.isAssetApproved !== undefined && !options.isAssetApproved(token.assetId)) {
      addFailure({
        code: "UNAPPROVED_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references unapproved asset identifier: "${token.assetId}"`,
        tokenKey: key,
      });
      continue;
    }

    if (options?.isAssetPublic !== undefined && !options.isAssetPublic(token.assetId)) {
      addFailure({
        code: "PRIVATE_ASSET",
        family: "unsafe_content",
        message: `Asset token "${key}" references non-public asset identifier "${token.assetId}". Only public platform assets may be referenced by themes.`,
        tokenKey: key,
      });
      continue;
    }
  }

  return { failures, ruleFailures };
}
