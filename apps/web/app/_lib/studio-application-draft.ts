import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  type OrganizationId,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  BuilderAuthorityError,
  readApplicationDefinitionDraft,
  requireBuilderAuthority,
} from "@vortex/definition";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

type StoredApplicationDefinitionDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type StudioAuthorityResult<Value> =
  | Readonly<{ kind: "available"; value: Value }>
  | Readonly<{ kind: "refused" }>;

const isExpectedBuilderRefusal = (error: unknown): boolean =>
  error instanceof BuilderAuthorityError &&
  (error.code === "BUILDER_PERMISSION_REFUSED" ||
    error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED");

export type StudioApplicationLoadResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId; draft: StoredApplicationDefinitionDraft }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type StudioApplicationCreateAccessResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

/** Mirrors the writer's protected classification; an unknown existing root is never ordinary. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (
    rows.length !== 1 || row === undefined || row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  ) throw new Error("STUDIO_DRAFT_UNAVAILABLE");
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

/** Organization selection is resolved from the current signed-in human on every request. */
export const loadStudioCreateAccess = async (
  candidateOrganizationId: string,
): Promise<StudioApplicationCreateAccessResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  if (!organization.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
      ): Promise<StudioAuthorityResult<OrganizationId>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change" });
        } catch (error) {
          if (isExpectedBuilderRefusal(error)) return { kind: "refused" };
          throw error;
        }
        return { kind: "available", value: scope.organizationId };
      },
    );
    return result.kind === "available"
      ? result.value.kind === "available"
        ? { kind: "available", organizationId: result.value.value }
        : { kind: "refused" }
      : result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
};

/** Classification, permission and detached draft read share one verified request transaction. */
export const loadStudioApplicationDraft = async (
  candidateOrganizationId: string,
  candidateRootId: string,
): Promise<StudioApplicationLoadResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
      ): Promise<StudioAuthorityResult<Readonly<{
        organizationId: OrganizationId;
        draft: StoredApplicationDefinitionDraft;
      }>>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
        } catch (error) {
          if (isExpectedBuilderRefusal(error)) return { kind: "refused" };
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
        return { kind: "available", value: { organizationId: scope.organizationId, draft } };
      },
    );
    return result.kind === "available"
      ? result.value.kind === "available"
        ? { kind: "available", ...result.value.value }
        : { kind: "refused" }
      : result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
};
