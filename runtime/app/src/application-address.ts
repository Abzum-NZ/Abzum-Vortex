import "server-only";

import {
  applicationRootIdSchema,
  builderKeySchema,
  identityAuthorityIdSchema,
  identitySessionSchema,
  namespacedKeySchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  pageIdSchema,
  permissionIdSchema,
  revisionSchema,
  roleIdSchema,
  type IdentityAuthorityId,
  type IdentitySession,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  runOrganizationAccessOperation,
} from "@vortex/access";
import { withRuntimeTransaction } from "@vortex/db";
import { z } from "zod";

const reservedTenantSegments = new Set([
  "auth", "health", "organizations", "signed-in", "signin", "api",
]);

export const isReservedTenantSegment = (candidate: string): boolean =>
  reservedTenantSegments.has(candidate.toLowerCase());

const applicationPermissionSchema = z.object({
  key: namespacedKeySchema,
  applicationRootId: applicationRootIdSchema,
  ownerKind: z.enum(["application", "module"]),
  ownerId: z.uuid(),
  permissionId: permissionIdSchema,
  actionKind: z.enum(["create", "read", "update", "delete", "restore", "export", "share", "manage", "named"]),
  namedAction: z.string().nullable(),
}).strict();

const applicationCandidateSchema = z.object({
  applicationRootId: applicationRootIdSchema,
  releaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
  key: namespacedKeySchema,
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(120),
  homePageKey: builderKeySchema,
  pages: z.array(z.object({
    pageId: pageIdSchema,
    key: builderKeySchema,
    accessPermissionKey: namespacedKeySchema,
  }).strict()).min(1).max(10_000),
  roles: z.array(z.object({
    roleId: roleIdSchema,
    key: builderKeySchema,
    homePageId: pageIdSchema,
  }).strict()).min(1).max(10_000),
  permissions: z.array(applicationPermissionSchema).max(10_000),
}).strict();

const addressCandidateReadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    organizationId: organizationIdSchema,
    tenantShortName: builderKeySchema,
    organizationShortName: builderKeySchema,
    applications: z.array(applicationCandidateSchema).max(10_000),
  }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

export const permittedApplicationSchema = z.object({
  applicationRootId: applicationRootIdSchema,
  key: namespacedKeySchema,
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(120),
  homePageKey: builderKeySchema,
  pageKeys: z.array(builderKeySchema).min(1).max(10_000),
}).strict();

export const permittedApplicationsReadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    organizationId: organizationIdSchema,
    tenantShortName: builderKeySchema,
    organizationShortName: builderKeySchema,
    defaultApplicationRootId: applicationRootIdSchema.nullable(),
    applications: z.array(permittedApplicationSchema).max(10_000),
  }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export type PermittedApplication = z.infer<typeof permittedApplicationSchema>;
export type PermittedApplicationsRead = z.infer<typeof permittedApplicationsReadSchema>;

type AddressRow = Readonly<{ address: unknown }>;
type SourceRoleRow = Readonly<{ source_role_id: unknown }>;
type CurrentReleaseRow = Readonly<{ current_release: unknown }>;
type ApplicationCandidate = z.infer<typeof applicationCandidateSchema>;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const permittedApplication = async (
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  candidate: ApplicationCandidate,
): Promise<PermittedApplication | null | "temporarily_unavailable"> => {
  const result = await requests.run(
    session,
    { organizationId, applicationRootId: candidate.applicationRootId },
    async (transaction, scope) => {
      const releaseRows = await transaction.query<CurrentReleaseRow>`
        select vortex_module.is_current_application_address_release(
          ${candidate.releaseRevision}::bigint
        ) as current_release
      `;
      if (releaseRows.length !== 1 || releaseRows[0] === undefined ||
          typeof releaseRows[0].current_release !== "boolean")
        throw new Error("APPLICATION_ADDRESS_RELEASE_UNAVAILABLE");
      if (!releaseRows[0].current_release) return null;

      const roleRows = await transaction.query<SourceRoleRow>`
        select source_role_id from vortex_access.read_current_application_role_ids_for_launcher()
      `;
      const activeRoleIds = new Set(
        roleRows.map((row) => roleIdSchema.parse(row.source_role_id).toLowerCase()),
      );
      const allowedPageKeys = new Set<string>();
      if (new Set(candidate.pages.map((page) => page.key)).size !== candidate.pages.length)
        throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");

      for (const page of candidate.pages) {
        const matches = candidate.permissions.filter(
          (entry) => entry.key === page.accessPermissionKey,
        );
        if (matches.length !== 1 || matches[0] === undefined)
          throw new Error("APPLICATION_PAGE_PERMISSION_UNAVAILABLE");
        const permission = matches[0];
        const declaration = organizationAccessDeclarationSchema.parse({
          operationKey: "application.page.discover",
          action: {
            actionKind: permission.actionKind,
            ...(permission.namedAction === null ? {} : { namedAction: permission.namedAction }),
          },
          target: { kind: "application", applicationRootId: candidate.applicationRootId },
          requiredPermission: {
            applicationRootId: permission.applicationRootId,
            ownerKind: permission.ownerKind,
            ownerId: permission.ownerId,
            permissionId: permission.permissionId,
          },
          recentAuthentication: { kind: "none" },
          authority: { kind: "permission" },
        });
        const decision = await runOrganizationAccessOperation(
          transaction, scope, declaration, async () => true,
        );
        if (decision.outcome === "completed") allowedPageKeys.add(page.key);
      }

      // The release home wins if authorised. Otherwise use the lowest source
      // role key among current application roles with an open home.
      const roleHome = [...candidate.roles]
        .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        .filter((role) => activeRoleIds.has(role.roleId.toLowerCase()))
        .map((role) => candidate.pages.find((page) => sameUuid(page.pageId, role.homePageId)))
        .find((page) => page !== undefined && allowedPageKeys.has(page.key));
      const homePageKey = allowedPageKeys.has(candidate.homePageKey)
        ? candidate.homePageKey
        : roleHome?.key;
      if (homePageKey === undefined) return null;

      return permittedApplicationSchema.parse({
        applicationRootId: candidate.applicationRootId,
        key: candidate.key,
        name: candidate.name,
        icon: candidate.icon,
        homePageKey,
        pageKeys: [...allowedPageKeys].sort(),
      });
    },
  );
  if (result.kind === "temporarily_unavailable") return "temporarily_unavailable";
  if (result.kind === "unavailable") return null;
  return result.value;
};

/** Resolve an exact tenant and organisation, then project only current page authority. */
export const readPermittedApplicationsAtAddress = async (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
): Promise<PermittedApplicationsRead> => {
  const parsedSession = identitySessionSchema.safeParse(session);
  const tenantShortName = builderKeySchema.safeParse(tenantShortNameCandidate);
  const organizationShortName = builderKeySchema.safeParse(organizationShortNameCandidate);
  const authorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  if (!parsedSession.success || !tenantShortName.success || !organizationShortName.success ||
      isReservedTenantSegment(tenantShortNameCandidate))
    return { kind: "unavailable" };
  if (!authorityId.success) return { kind: "temporarily_unavailable" };
  if (Date.parse(parsedSession.data.accessTokenExpiresAt) <= Date.now())
    return { kind: "unavailable" };

  try {
    const read = await withRuntimeTransaction(async (transaction) => {
      const rows = await transaction.query<AddressRow>`
        select vortex_module.read_application_address_candidates(
          ${parsedSession.data.identityId}::uuid,
          ${tenantShortName.data}::text,
          ${organizationShortName.data}::text
        ) as address
      `;
      if (rows.length !== 1) throw new Error("INVALID_APPLICATION_ADDRESS_RESULT");
      return addressCandidateReadSchema.parse(rows[0]?.address);
    });
    if (read.kind !== "available") return read;

    const requests = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId.data,
    });
    const defaultRead = await requests.run(
      parsedSession.data,
      { organizationId: read.organizationId },
      (transaction) => readCurrentOrganizationDefaultApplicationAfterAuthorization(transaction),
    );
    if (defaultRead.kind !== "available") return defaultRead;

    const applications: PermittedApplication[] = [];
    for (const candidate of read.applications) {
      const permitted = await permittedApplication(
        requests, parsedSession.data, read.organizationId, candidate,
      );
      if (permitted === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (permitted !== null) applications.push(permitted);
    }
    const configuredDefault = defaultRead.value;
    const defaultApplicationRootId = configuredDefault !== null && applications.some((entry) =>
      sameUuid(entry.applicationRootId, configuredDefault)
    ) ? configuredDefault : null;
    return permittedApplicationsReadSchema.parse({
      kind: "available",
      organizationId: read.organizationId,
      tenantShortName: read.tenantShortName,
      organizationShortName: read.organizationShortName,
      defaultApplicationRootId,
      applications,
    });
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

/** A browser address selects only from the currently permitted server projection. */
export const resolvePermittedApplicationAddress = (
  read: PermittedApplicationsRead,
  applicationKeyCandidate?: string,
  pageKeyCandidate?: string,
) => {
  if (read.kind !== "available") return read;
  if (applicationKeyCandidate === undefined)
    return { kind: "available" as const, read, application: null, pageKey: null };

  const applicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
  if (!applicationKey.success) return { kind: "unavailable" as const };
  const application = read.applications.find((entry) => entry.key === applicationKey.data);
  if (!application) return { kind: "unavailable" as const };

  const pageKey = pageKeyCandidate === undefined
    ? application.homePageKey
    : builderKeySchema.safeParse(pageKeyCandidate).success
      ? pageKeyCandidate
      : null;
  if (pageKey === null || !application.pageKeys.includes(pageKey))
    return { kind: "unavailable" as const };

  return { kind: "available" as const, read, application, pageKey };
};
