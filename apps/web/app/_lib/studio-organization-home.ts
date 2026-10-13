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
    }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

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
      const roots = await listOrganizationBuilderRoots(transaction);
      const byId = new Map(roots.map((root) => [root.rootId, root]));
      const targetFacts: BuilderTargetFactsReader = async (_transaction, _scope, rootId) => {
        if (rootId === undefined) return { isSystemApplication: false };
        const root = byId.get(rootId);
        if (root === undefined) throw new Error("STUDIO_ROOT_LIST_TARGET_MISSING");
        return { isSystemApplication: root.isSystemApplication };
      };
      const authority = createBuilderAuthority({ transaction, scope, targetFacts });
      const visible: OrganizationBuilderRoot[] = [];
      for (const root of roots) {
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.rootId });
          visible.push(root);
        } catch (error) {
          if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED")
            continue;
          throw error;
        }
      }
      return { organizationId: scope.organizationId, roots: visible };
    },
  );
  if (result.kind === "available") return { kind: "available", ...result.value };
  if (result.kind === "unavailable")
    return {
      kind: "refused",
      reason: "You need permission to manage definition drafts in this organization.",
    };
  return { kind: "temporarily_unavailable" };
};
