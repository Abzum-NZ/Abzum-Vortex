import "server-only";

import {
  BuilderAuthorityError,
  createBuilderAuthority,
  listOrganizationBuilderRoots,
  requireBuilderAuthority,
  type BuilderTargetFactsReader,
  type OrganizationBuilderRoot,
} from "@web/platform-server";
import { organizationIdSchema, type OrganizationId } from "@vortex/platform/schema";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

export type StudioOrganizationHomeResult =
  | Readonly<{
      kind: "available";
      organizationId: OrganizationId;
      roots: readonly OrganizationBuilderRoot[];
      mayHaveMore: boolean;
    }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const permissionRefusal = "You need permission to manage definition drafts in this organization.";

export const loadStudioOrganizationHome = async (
  candidateOrganizationId: string,
): Promise<StudioOrganizationHomeResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  if (!organization.success) {
    console.error(
      "[studio] organization home refused: invalid organization identifier",
      organization.error,
    );
    return { kind: "refused", reason: "The organization address is invalid." };
  }
  const resolved = await resolveIdentitySession();
  if (resolved.kind !== "active") {
    console.error(`[studio] organization home refused: identity session ${resolved.kind}`);
    return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused", reason: "Sign in to open this Studio workspace." };
  }

  const result = await humanOrganizationRequests().run(
    resolved.session,
    { organizationId: organization.data },
    async (transaction, scope) => {
      const organizationFacts: BuilderTargetFactsReader = async (_transaction, _scope, rootId) => {
        if (rootId !== undefined) throw new Error("STUDIO_ROOT_LIST_TARGET_MISSING");
        return { isSystemApplication: false };
      };
      const organizationAuthority = createBuilderAuthority({
        transaction,
        scope,
        targetFacts: organizationFacts,
      });
      try {
        await requireBuilderAuthority(organizationAuthority, { kind: "draft_change" });
      } catch (error) {
        if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED") {
          console.error(`[studio] organization home refused: ${error.code}`);
          return { kind: "refused" as const, reason: permissionRefusal };
        }
        throw error;
      }
      const roots = await listOrganizationBuilderRoots(transaction);
      const systemRoot = roots.find((root) => root.isSystemApplication);
      if (systemRoot === undefined)
        return {
          kind: "available" as const,
          organizationId: scope.organizationId,
          roots,
          mayHaveMore: roots.length === 200,
        };

      const targetFacts: BuilderTargetFactsReader = async (_transaction, _scope, rootId) => {
        if (rootId !== systemRoot.rootId) throw new Error("STUDIO_ROOT_LIST_TARGET_MISSING");
        return { isSystemApplication: true };
      };
      const authority = createBuilderAuthority({ transaction, scope, targetFacts });
      try {
        await requireBuilderAuthority(authority, {
          kind: "draft_change",
          rootId: systemRoot.rootId,
        });
        return {
          kind: "available" as const,
          organizationId: scope.organizationId,
          roots,
          mayHaveMore: roots.length === 200,
        };
      } catch (error) {
        if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED")
          return {
            kind: "available" as const,
            organizationId: scope.organizationId,
            roots: roots.filter((root) => !root.isSystemApplication),
            mayHaveMore: roots.length === 200,
          };
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (result.kind === "unavailable") {
    console.error("[studio] organization home could not resolve the protected request scope");
    return { kind: "temporarily_unavailable" };
  }
  console.error(`[studio] organization home could not load: ${result.cause ?? result.kind}`);
  return { kind: "temporarily_unavailable" };
};
