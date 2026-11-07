import "server-only";

import {
  BuilderAuthorityError,
  createBuilderAuthority,
  listOrganizationBuilderRoots,
  requireBuilderAuthority,
  readVisiblePersonLabels,
  type BuilderTargetFactsReader,
  type OrganizationBuilderRoot,
  logRefusal,
} from "@vortex/platform/server";
import { organizationIdSchema, type OrganizationId } from "@vortex/platform/schema";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";

type StudioOrganizationHomeResult =
  | Readonly<{
      kind: "available";
      organizationId: OrganizationId;
      roots: readonly OrganizationBuilderRoot[];
      nextCursor: string | null;
      editorNames: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const permissionRefusal = "You need permission to manage definition drafts in this organization.";

export const loadStudioOrganizationHome = async (
  candidateOrganizationId: string,
  afterKey: string | null = null,
): Promise<StudioOrganizationHomeResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  if (!organization.success) {
    logRefusal("studio", "organization home", "invalid_organization_identifier");
    return { kind: "refused", reason: "The organization address is invalid." };
  }
  const resolved = await resolveIdentitySession();
  if (resolved.kind !== "active") {
    if (resolved.kind === "temporarily_unavailable") {
      console.error("[studio] organization home failed: identity session temporarily_unavailable");
      return { kind: "temporarily_unavailable" };
    }
    logRefusal("studio", "organization home", `identity_session_${resolved.kind}`);
    return { kind: "refused", reason: "Sign in to open this Studio workspace." };
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
        permissions: platformPermissionSource,
      });
      try {
        await requireBuilderAuthority(organizationAuthority, { kind: "draft_change" });
      } catch (error) {
        if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED") {
          logRefusal("studio", "organization home", error.code);
          return { kind: "refused" as const, reason: permissionRefusal };
        }
        throw error;
      }
      const page = await listOrganizationBuilderRoots(transaction, afterKey);
      const roots = page.roots;
      const labels = await readVisiblePersonLabels(transaction, [
        ...new Set(roots.map((root) => root.editedBy)),
      ]);
      const paging = { nextCursor: page.nextCursor, editorNames: Object.fromEntries(labels) };
      const systemRoot = roots.find((root) => root.isSystemApplication);
      if (systemRoot === undefined)
        return {
          kind: "available" as const,
          organizationId: scope.organizationId,
          roots,
          ...paging,
        };

      const targetFacts: BuilderTargetFactsReader = async (_transaction, _scope, rootId) => {
        if (rootId !== systemRoot.rootId) throw new Error("STUDIO_ROOT_LIST_TARGET_MISSING");
        return { isSystemApplication: true };
      };
      const authority = createBuilderAuthority({
        transaction,
        scope,
        targetFacts,
        permissions: platformPermissionSource,
      });
      try {
        await requireBuilderAuthority(authority, {
          kind: "draft_change",
          rootId: systemRoot.rootId,
        });
        return {
          kind: "available" as const,
          organizationId: scope.organizationId,
          roots,
          ...paging,
        };
      } catch (error) {
        if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED")
          return {
            kind: "available" as const,
            organizationId: scope.organizationId,
            roots: roots.filter((root) => !root.isSystemApplication),
            ...paging,
          };
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  // The request runner logged this answer once.
  return { kind: "temporarily_unavailable" };
};
