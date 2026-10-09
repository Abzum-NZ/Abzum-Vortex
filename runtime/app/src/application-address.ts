import "server-only";

import {
  databaseTimestamp,
  sameId,
  applicationExperienceStateSchema,
  applicationRootIdSchema,
  applicationShellV2Schema,
  applicationThemeV2Schema,
  builderKeySchema,
  identityAuthorityIdSchema,
  identitySessionSchema,
  organizationLauncherEntrySchema,
  isPresentationOnlyApplicationExperience,
  namespacedKeySchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  pageDefinitionV2Schema,
  pageIdSchema,
  permissionIdSchema,
  revisionSchema,
  roleIdSchema,
  sessionContextSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type OrganizationAccessDeclaration,
} from "@vortex/contracts";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/modules";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  runOrganizationAccessOperation,
} from "@vortex/access";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";
import { z } from "zod";
import {
  createHumanInstalledPageBundleContextLoader,
  matchesInstalledPageBundleIdentity,
  type HumanInstalledPageBundleContextDependencies,
} from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";

const reservedTenantSegments = new Set([
  "auth",
  "health",
  "signed-in",
  "signin",
  "api",
]);

export const isReservedTenantSegment = (candidate: string): boolean =>
  reservedTenantSegments.has(candidate.toLowerCase());

const applicationPermissionSchema = z
  .object({
    key: namespacedKeySchema,
    applicationRootId: applicationRootIdSchema,
    ownerKind: z.enum(["application", "module"]),
    ownerId: z.uuid(),
    permissionId: permissionIdSchema,
    actionKind: z.enum([
      "create",
      "read",
      "update",
      "delete",
      "restore",
      "export",
      "share",
      "manage",
      "named",
    ]),
    namedAction: z.string().nullable(),
  })
  .strict();

const applicationCandidateSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    releaseRevision: revisionSchema,
    key: namespacedKeySchema,
    name: z.string().trim().min(1).max(120),
    icon: z.string().trim().min(1).max(120),
    homePageKey: builderKeySchema,
    pages: z
      .array(
        z
          .object({
            pageId: pageIdSchema,
            key: builderKeySchema,
            accessPermissionKey: namespacedKeySchema,
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    experiences: z
      .array(
        z
          .object({
            state: applicationExperienceStateSchema,
            page: pageDefinitionV2Schema,
          })
          .strict(),
      )
      .max(3)
      .optional(),
    shells: z.array(applicationShellV2Schema).max(100).optional(),
    theme: applicationThemeV2Schema.optional(),
    roles: z
      .array(
        z
          .object({
            roleId: roleIdSchema,
            key: builderKeySchema,
            homePageId: pageIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    permissions: z.array(applicationPermissionSchema).max(10_000),
  })
  .strict();

const addressCandidateReadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      organizationId: organizationIdSchema,
      tenantShortName: builderKeySchema,
      organizationShortName: builderKeySchema,
      applications: z.array(applicationCandidateSchema).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("suspended_super_administrator_account") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

export const permittedApplicationSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    key: namespacedKeySchema,
    name: z.string().trim().min(1).max(120),
    icon: z.string().trim().min(1).max(120),
    homePageKey: builderKeySchema,
    pageKeys: z.array(builderKeySchema).min(1).max(10_000),
  })
  .strict();

/**
 * One application experience page the viewer may be shown in place of a page they cannot open:
 * the viewer may open that page itself, it is presentation-only, and it carries only the shell and
 * release theme it renders in.
 */
export const applicationExperienceSchema = z
  .object({
    state: applicationExperienceStateSchema,
    page: pageDefinitionV2Schema,
    shells: z.array(applicationShellV2Schema).max(1),
    theme: applicationThemeV2Schema.optional(),
  })
  .strict();

export const permittedApplicationsReadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      organizationId: organizationIdSchema,
      tenantShortName: builderKeySchema,
      organizationShortName: builderKeySchema,
      defaultApplicationRootId: applicationRootIdSchema.nullable(),
      applications: z.array(permittedApplicationSchema).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("suspended_super_administrator_account") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export type PermittedApplication = z.infer<typeof permittedApplicationSchema>;
export type PermittedApplicationsRead = z.infer<typeof permittedApplicationsReadSchema>;
export type ApplicationExperience = z.infer<typeof applicationExperienceSchema>;

/**
 * An addressed read: the permitted-applications read for one application key, plus the
 * experience pages of that application when the viewer may open it. Experiences never enter
 * `PermittedApplicationsRead`, so the launcher and organisation reads keep their exact shape.
 */
export type AddressedApplicationRead = Readonly<{
  read: PermittedApplicationsRead;
  experiences: readonly ApplicationExperience[];
}>;

/** The addressed projection and the exact HUMAN installed context that authorized it. */
export type AddressedApplicationBundleRead = Readonly<{
  read: PermittedApplicationsRead;
  experiences: readonly ApplicationExperience[];
  context?: InstalledRuntimeContext;
  identity?: AddressedActiveApplicationIdentity;
}>;

export type AddressedBundleDefinitionReaderFactory = (
  transaction: RequestDatabaseTransaction,
) => HumanInstalledPageBundleContextDependencies["releaseSetReader"];

type AddressRow = Readonly<{ address: unknown }>;
type OrganizationLauncherRow = DatabaseRow & Readonly<{
  organization_id: unknown;
  tenant_short_name: unknown;
  tenant_display_name: unknown;
  organization_short_name: unknown;
  organization_display_name: unknown;
  account_display_name: unknown;
}>;
type AddressCompletionContextRow = DatabaseRow & Readonly<{
  request_context: unknown;
}>;
type AddressCompletionClockRow = DatabaseRow & Readonly<{
  observed_at: unknown;
}>;
type AddressCompletionBundleRow = DatabaseRow & Readonly<{
  bundle_state: unknown;
}>;
type SourceRoleRow = Readonly<{ source_role_id: unknown }>;
type CurrentReleaseRow = Readonly<{ current_release: unknown }>;
type AddressedIdentityRow = Readonly<{ addressed_identity: unknown }>;
type ApplicationCandidate = z.infer<typeof applicationCandidateSchema>;

const applicationCandidateFromInstalledContext = (
  context: InstalledRuntimeContext,
): ApplicationCandidate => {
  const application = context.releaseSet.application;
  const pages = application.content.pages;
  const pagePermissionKeys = new Set(pages.map((page) => page.accessPermissionKey));
  const homePages = pages.filter((page) => sameId(page.pageId, application.content.homePageId));
  if (homePages.length !== 1 || homePages[0] === undefined)
    throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");
  const experiences = (application.content.experiences ?? []).map((experience) => {
    const matches = pages.filter((page) => sameId(page.pageId, experience.pageId));
    if (matches.length !== 1 || matches[0] === undefined)
      throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");
    return { state: experience.state, page: matches[0] };
  });
  const permissions = context.permissionRegistration.entries
    .filter((entry) => pagePermissionKeys.has(entry.permission.key))
    .map((entry) => ({
      key: entry.permission.key,
      applicationRootId: entry.applicationRootId,
      ownerKind: entry.ownerKind,
      ownerId: entry.ownerId,
      permissionId: entry.permission.permissionId,
      actionKind: entry.permission.actionKind,
      namedAction: entry.permission.namedAction ?? null,
    }));
  return applicationCandidateSchema.parse({
    applicationRootId: application.rootId,
    releaseRevision: application.releaseRevision,
    key: application.definitionKey,
    name: application.content.name,
    icon: application.content.icon,
    homePageKey: homePages[0].key,
    pages: pages.map((page) => ({
      pageId: page.pageId,
      key: page.key,
      accessPermissionKey: page.accessPermissionKey,
    })),
    roles: application.content.roles.map((role) => ({
      roleId: role.roleId,
      key: role.key,
      homePageId: role.homePageId,
    })),
    permissions,
    experiences,
    shells: application.content.shells,
    theme: application.content.theme,
  });
};

const addressedActiveApplicationIdentitySchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  definitionKey: namespacedKeySchema,
  applicationReleaseRevision: revisionSchema,
}).strict();

export type AddressedActiveApplicationIdentity = z.infer<
  typeof addressedActiveApplicationIdentitySchema
>;

const permittedApplication = async (
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  candidate: ApplicationCandidate,
  expectedContext?: InstalledRuntimeContext,
): Promise<
  | Readonly<{ application: PermittedApplication; experiences: ApplicationExperience[] }>
  | null
  | "temporarily_unavailable"
> => {
  const result = await requests.run(
    session,
    { organizationId, applicationRootId: candidate.applicationRootId },
    async (transaction, scope) => {
      const releaseRows = await transaction.query<CurrentReleaseRow>`
        select vortex_module.is_current_application_address_release(
          ${candidate.releaseRevision}::bigint
        ) as current_release
      `;
      if (
        releaseRows.length !== 1 ||
        releaseRows[0] === undefined ||
        typeof releaseRows[0].current_release !== "boolean"
      )
        throw new Error("APPLICATION_ADDRESS_RELEASE_UNAVAILABLE");
      if (!releaseRows[0].current_release) return null;

      const roleRows = await transaction.query<SourceRoleRow>`
        select source_role_id from vortex_access.read_current_application_role_ids_for_launcher()
      `;
      const activeRoleIds = new Set(
        roleRows.map((row) => roleIdSchema.parse(row.source_role_id).toLowerCase()),
      );
      const allowedPageKeys = new Set<string>();
      let earliestAccessDeadline: string | undefined;
      const retainAccessDeadline = (deadline: string): void => {
        const candidateMilliseconds = Date.parse(deadline);
        if (!Number.isFinite(candidateMilliseconds))
          throw new Error("APPLICATION_PAGE_PERMISSION_UNAVAILABLE");
        if (earliestAccessDeadline === undefined ||
          candidateMilliseconds < Date.parse(earliestAccessDeadline))
          earliestAccessDeadline = deadline;
      };
      if (new Set(candidate.pages.map((page) => page.key)).size !== candidate.pages.length)
        throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");

      for (const page of candidate.pages) {
        // A page requirement names either a permission from this application's own catalogue or
        // an exact platform administration permission from the shipped platform catalogue. A
        // platform permission is organisation-scoped, so its declaration targets the organisation.
        const platformDeclaration = platformPermissionFor(page.accessPermissionKey);
        let declaration: OrganizationAccessDeclaration;
        if (platformDeclaration !== undefined) {
          declaration = organizationAccessDeclarationSchema.parse({
            operationKey: "application.page.discover",
            action: {
              actionKind: platformDeclaration.actionKind,
              ...(platformDeclaration.namedAction === undefined
                ? {}
                : { namedAction: platformDeclaration.namedAction }),
            },
            target: { kind: "organization" },
            requiredPermission: {
              ownerKind: "platform",
              ownerId: platformPermissionOwnerId,
              permissionId: platformDeclaration.permissionId,
            },
            recentAuthentication: { kind: "none" },
            authority: { kind: "permission" },
          });
        } else {
          const matches = candidate.permissions.filter(
            (entry) => entry.key === page.accessPermissionKey,
          );
          if (matches.length !== 1 || matches[0] === undefined)
            throw new Error("APPLICATION_PAGE_PERMISSION_UNAVAILABLE");
          const permission = matches[0];
          declaration = organizationAccessDeclarationSchema.parse({
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
        }
        const decision = await runOrganizationAccessOperation(
          transaction,
          scope,
          declaration,
          async (decision) => {
            retainAccessDeadline(decision.validUntil);
            return true;
          },
        );
        if (decision.outcome === "completed") allowedPageKeys.add(page.key);
      }

      // The release home wins if authorised. Otherwise use the lowest source
      // role key among current application roles with an open home.
      const roleHome = [...candidate.roles]
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .filter((role) => activeRoleIds.has(role.roleId.toLowerCase()))
        .map((role) => candidate.pages.find((page) => sameId(page.pageId, role.homePageId)))
        .find((page) => page !== undefined && allowedPageKeys.has(page.key));
      const homePageKey = allowedPageKeys.has(candidate.homePageKey)
        ? candidate.homePageKey
        : roleHome?.key;
      if (homePageKey === undefined) return null;

      // An experience page is offered only when the viewer may open that page itself and it is
      // presentation-only, so it can never show gated, conditional or data-bound content.
      const shells = candidate.shells ?? [];
      const experiences = (candidate.experiences ?? [])
        .filter(
          (experience) =>
            allowedPageKeys.has(experience.page.key) &&
            isPresentationOnlyApplicationExperience(experience.page, shells),
        )
        .map((experience) => {
          const composition = experience.page.composition;
          const shellId = composition.shellKind === "application" ? composition.shellId : undefined;
          return applicationExperienceSchema.parse({
            state: experience.state,
            page: experience.page,
            shells:
              shellId === undefined ? [] : shells.filter((shell) => sameId(shell.shellId, shellId)),
            ...(candidate.theme === undefined ? {} : { theme: candidate.theme }),
          });
        });

      if (expectedContext !== undefined) {
        if (earliestAccessDeadline === undefined) return null;
        const bundleRows = await transaction.query<AddressCompletionBundleRow>`
          select vortex_module.read_active_installation_bundle_identity() as bundle_state
        `;
        if (
          bundleRows.length !== 1 ||
          bundleRows[0] === undefined ||
          !matchesInstalledPageBundleIdentity(
            expectedContext,
            bundleRows[0].bundle_state,
            scope.accessVersion,
            scope.organizationAccountId,
          )
        ) return null;

        const contextRows = await transaction.query<AddressCompletionContextRow>`
          select vortex_access.validated_human_request_context() as request_context
        `;
        if (contextRows.length !== 1 || contextRows[0] === undefined) return null;
        const current = sessionContextSchema.safeParse(contextRows[0].request_context);
        if (!current.success || current.data.callerKind !== "human") return null;

        const clockRows = await transaction.query<AddressCompletionClockRow>`
          select clock_timestamp() as observed_at
        `;
        if (clockRows.length !== 1 || clockRows[0] === undefined) return null;
        const observedAt = databaseTimestamp(clockRows[0].observed_at);
        if (typeof observedAt !== "string") return null;
        const observedMilliseconds = Date.parse(observedAt);
        const earliestDeadlineMilliseconds = Date.parse(earliestAccessDeadline);
        if (!Number.isFinite(observedMilliseconds) ||
          !Number.isFinite(earliestDeadlineMilliseconds) ||
          current.data.expiresAt === undefined ||
          Date.parse(current.data.expiresAt) <= observedMilliseconds ||
          (current.data.delegatedContext !== undefined &&
            Date.parse(current.data.delegatedContext.expiresAt) <= observedMilliseconds) ||
          (current.data.supportContext !== undefined &&
            Date.parse(current.data.supportContext.expiresAt) <= observedMilliseconds) ||
          !sameId(current.data.tenantId, scope.tenantId) ||
          !sameId(current.data.organizationId, scope.organizationId) ||
          !sameId(current.data.organizationAccountId, scope.organizationAccountId) ||
          scope.applicationRootId === undefined ||
          !sameId(current.data.applicationRootId, scope.applicationRootId) ||
          current.data.accessVersion !== scope.accessVersion ||
          earliestDeadlineMilliseconds <= observedMilliseconds) return null;
      }

      return {
        application: permittedApplicationSchema.parse({
          applicationRootId: candidate.applicationRootId,
          key: candidate.key,
          name: candidate.name,
          icon: candidate.icon,
          homePageKey,
          pageKeys: [...allowedPageKeys].sort(),
        }),
        experiences,
      };
    },
  );
  if (result.kind === "temporarily_unavailable") return "temporarily_unavailable";
  if (result.kind === "unavailable") return null;
  return result.value;
};

/**
 * Resolve an exact tenant and organisation, then project only current page authority.
 * Without an application key this is the launcher read: every permitted application and
 * the organisation default. With a key it is an addressed page read: only that application
 * is evaluated, `applications` holds at most that one entry and `defaultApplicationRootId`
 * is null, so it must only resolve that address and never feed a launcher.
 */
export const readPermittedApplicationsAtAddress = async (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate?: string,
): Promise<PermittedApplicationsRead> =>
  (
    await readAtAddress(
      session,
      tenantShortNameCandidate,
      organizationShortNameCandidate,
      identityAuthorityIdCandidate,
      applicationKeyCandidate,
    )
  ).read;

/**
 * The addressed page read with the addressed application's experience pages. They are returned
 * only while the viewer may open that application, so an unknown or refused application never
 * discloses any of its content.
 */
export const readAddressedApplicationAtAddress = (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<AddressedApplicationRead> =>
  readAtAddress(
    session,
    tenantShortNameCandidate,
    organizationShortNameCandidate,
    identityAuthorityIdCandidate,
    applicationKeyCandidate,
  );

/** Resolves one addressed App from the current HUMAN installed bundle and page authority. */
export const readAddressedApplicationFromInstalledBundleAtAddress = async (
  sessionCandidate: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
  releaseSetReaderForTransaction: AddressedBundleDefinitionReaderFactory,
): Promise<AddressedApplicationBundleRead> => {
  const unavailable = (): AddressedApplicationBundleRead => ({
    read: { kind: "unavailable" },
    experiences: [],
  });
  const temporarilyUnavailable = (): AddressedApplicationBundleRead => ({
    read: { kind: "temporarily_unavailable" },
    experiences: [],
  });
  const session = identitySessionSchema.safeParse(sessionCandidate);
  const identityAuthorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  if (!session.success || !identityAuthorityId.success) return unavailable();

  const addressedIdentity = await readAddressedApplicationIdentityAtAddress(
    session.data,
    tenantShortNameCandidate,
    organizationShortNameCandidate,
    identityAuthorityId.data,
    applicationKeyCandidate,
  );
  if (addressedIdentity === undefined) return unavailable();

  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: identityAuthorityId.data,
  });
  try {
    const contextResult = await requests.run(
      session.data,
      {
        organizationId: addressedIdentity.organizationId,
        applicationRootId: addressedIdentity.identity.applicationRootId,
      },
      async (transaction, scope) => {
        if (scope.applicationRootId === undefined ||
          !sameId(scope.applicationRootId, addressedIdentity.identity.applicationRootId))
          return undefined;
        const context = await createHumanInstalledPageBundleContextLoader({
          transaction,
          releaseSetReader: releaseSetReaderForTransaction(transaction),
          scope: {
            organizationId: scope.organizationId,
            applicationRootId: scope.applicationRootId,
          },
        }).load();
        const application = context.releaseSet.application;
        if (!sameId(context.organizationId, addressedIdentity.organizationId) ||
          !sameId(context.applicationRootId, addressedIdentity.identity.applicationRootId) ||
          application.releaseRevision !== addressedIdentity.identity.applicationReleaseRevision ||
          application.definitionKey !== addressedIdentity.identity.definitionKey ||
          application.releaseRevision !== context.applicationReleaseRevision)
          return undefined;
        return context;
      },
    );
    if (contextResult.kind === "temporarily_unavailable") return temporarilyUnavailable();
    if (contextResult.kind !== "available" || contextResult.value === undefined)
      return unavailable();

    const context = contextResult.value;
    const candidate = applicationCandidateFromInstalledContext(context);
    const permitted = await permittedApplication(
      requests,
      session.data,
      addressedIdentity.organizationId,
      candidate,
      context,
    );
    if (permitted === "temporarily_unavailable") return temporarilyUnavailable();
    if (permitted === null) return unavailable();
    const read = permittedApplicationsReadSchema.parse({
      kind: "available",
      organizationId: addressedIdentity.organizationId,
      tenantShortName: addressedIdentity.tenantShortName,
      organizationShortName: addressedIdentity.organizationShortName,
      defaultApplicationRootId: null,
      applications: [permitted.application],
    });
    return {
      read,
      experiences: permitted.experiences,
      context,
      identity: addressedIdentity.identity,
    };
  } catch {
    return temporarilyUnavailable();
  }
};

/** Resolves only the active Application identity under its exact HUMAN organization request. */
export const readAddressedActiveApplicationIdentity = async (
  sessionCandidate: IdentitySession,
  organizationIdCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<AddressedActiveApplicationIdentity | undefined> => {
  const session = identitySessionSchema.safeParse(sessionCandidate);
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const identityAuthorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  const applicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
  if (!session.success || !organizationId.success || !identityAuthorityId.success || !applicationKey.success)
    return undefined;
  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: identityAuthorityId.data,
  });
  const result = await requests.run(
    session.data,
    { organizationId: organizationId.data },
    async (transaction, scope) => {
      if (scope.applicationRootId !== undefined)
        throw new Error("APPLICATION_ADDRESS_SCOPE_UNAVAILABLE");
      const rows = await transaction.query<AddressedIdentityRow>`
        select vortex_module.resolve_addressed_active_application_identity(
          ${applicationKey.data}::text
        ) as addressed_identity
      `;
      if (rows.length !== 1 || rows[0] === undefined)
        throw new Error("APPLICATION_ADDRESS_IDENTITY_UNAVAILABLE");
      const identity = addressedActiveApplicationIdentitySchema.safeParse(rows[0].addressed_identity);
      if (!identity.success || identity.data.organizationId !== organizationId.data ||
        identity.data.definitionKey !== applicationKey.data)
        throw new Error("APPLICATION_ADDRESS_IDENTITY_UNAVAILABLE");
      return identity.data;
    },
  );
  return result.kind === "available" ? result.value : undefined;
};

/** Resolves an address to a thin current active identity before any Application-scoped read. */
export const readAddressedApplicationIdentityAtAddress = async (
  sessionCandidate: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<Readonly<{
  organizationId: string;
  tenantShortName: string;
  organizationShortName: string;
  identity: AddressedActiveApplicationIdentity;
}> | undefined> => {
  const session = identitySessionSchema.safeParse(sessionCandidate);
  const tenantShortName = builderKeySchema.safeParse(tenantShortNameCandidate);
  const organizationShortName = builderKeySchema.safeParse(organizationShortNameCandidate);
  const identityAuthorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  const applicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
  if (
    !session.success || !tenantShortName.success || !organizationShortName.success ||
    !identityAuthorityId.success || !applicationKey.success ||
    isReservedTenantSegment(tenantShortNameCandidate) ||
    Date.parse(session.data.accessTokenExpiresAt) <= Date.now()
  ) return undefined;

  try {
    const rows = await withRuntimeTransaction(async (transaction) =>
      transaction.query<OrganizationLauncherRow>`
        select *
        from vortex_identity.list_organization_launcher(
          ${session.data.identityId}::uuid
        )
      `,
    );
    const entries = rows.map((row) => organizationLauncherEntrySchema.safeParse({
      organizationId: row.organization_id,
      tenantShortName: row.tenant_short_name,
      tenantDisplayName: row.tenant_display_name,
      organizationShortName: row.organization_short_name,
      organizationDisplayName: row.organization_display_name,
      ...(row.account_display_name === null || row.account_display_name === undefined
        ? {}
        : { accountDisplayName: row.account_display_name }),
    }));
    if (entries.some((entry) => !entry.success)) return undefined;
    const matchedEntries = entries.flatMap((entry) =>
      entry.success && entry.data.tenantShortName === tenantShortName.data &&
        entry.data.organizationShortName === organizationShortName.data
        ? [entry.data]
        : [],
    );
    if (matchedEntries.length !== 1 || matchedEntries[0] === undefined) return undefined;
    const address = matchedEntries[0];
    const identity = await readAddressedActiveApplicationIdentity(
      session.data,
      address.organizationId,
      identityAuthorityId.data,
      applicationKey.data,
    );
    if (
      identity === undefined ||
      identity.organizationId !== address.organizationId ||
      identity.definitionKey !== applicationKey.data
    ) return undefined;
    return Object.freeze({
      organizationId: address.organizationId,
      tenantShortName: address.tenantShortName,
      organizationShortName: address.organizationShortName,
      identity,
    });
  } catch {
    return undefined;
  }
};

const readAtAddress = async (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate?: string,
): Promise<AddressedApplicationRead> => {
  let experiences: readonly ApplicationExperience[] = [];
  const read = await readPermittedApplications(
    session,
    tenantShortNameCandidate,
    organizationShortNameCandidate,
    identityAuthorityIdCandidate,
    applicationKeyCandidate,
    (addressed) => {
      experiences = addressed;
    },
  );
  return { read, experiences: read.kind === "available" ? experiences : [] };
};

const readPermittedApplications = async (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string | undefined,
  receiveExperiences: (experiences: readonly ApplicationExperience[]) => void,
): Promise<PermittedApplicationsRead> => {
  const parsedSession = identitySessionSchema.safeParse(session);
  const tenantShortName = builderKeySchema.safeParse(tenantShortNameCandidate);
  const organizationShortName = builderKeySchema.safeParse(organizationShortNameCandidate);
  const authorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  if (
    !parsedSession.success ||
    !tenantShortName.success ||
    !organizationShortName.success ||
    isReservedTenantSegment(tenantShortNameCandidate)
  )
    return { kind: "unavailable" };
  if (!authorityId.success) return { kind: "temporarily_unavailable" };
  if (Date.parse(parsedSession.data.accessTokenExpiresAt) <= Date.now())
    return { kind: "unavailable" };

  let addressedApplicationKey: string | undefined;
  if (applicationKeyCandidate !== undefined) {
    const parsedApplicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
    if (!parsedApplicationKey.success) return { kind: "unavailable" };
    addressedApplicationKey = parsedApplicationKey.data;
  }

  try {
    const read = await withRuntimeTransaction(async (transaction) => {
      const rows = await transaction.query<AddressRow>`
        select vortex_access.read_application_address_candidates(
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

    // An addressed page request resolves only the named application, so the
    // request transaction and page access decisions cover that application's
    // pages alone. The launcher still builds the full permitted list below.
    if (addressedApplicationKey !== undefined) {
      const candidate = read.applications.find((entry) => entry.key === addressedApplicationKey);
      if (candidate === undefined) return { kind: "unavailable" };
      const permitted = await permittedApplication(
        requests,
        parsedSession.data,
        read.organizationId,
        candidate,
      );
      if (permitted === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (permitted !== null) receiveExperiences(permitted.experiences);
      return permittedApplicationsReadSchema.parse({
        kind: "available",
        organizationId: read.organizationId,
        tenantShortName: read.tenantShortName,
        organizationShortName: read.organizationShortName,
        defaultApplicationRootId: null,
        applications: permitted === null ? [] : [permitted.application],
      });
    }

    const defaultRead = await requests.run(
      parsedSession.data,
      { organizationId: read.organizationId },
      (transaction) => readCurrentOrganizationDefaultApplicationAfterAuthorization(transaction),
    );
    if (defaultRead.kind !== "available") return defaultRead;

    const applications: PermittedApplication[] = [];
    for (const candidate of read.applications) {
      const permitted = await permittedApplication(
        requests,
        parsedSession.data,
        read.organizationId,
        candidate,
      );
      if (permitted === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (permitted !== null) applications.push(permitted.application);
    }
    const configuredDefault = defaultRead.value;
    const defaultApplicationRootId =
      configuredDefault !== null &&
      applications.some((entry) => sameId(entry.applicationRootId, configuredDefault))
        ? configuredDefault
        : null;
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

  const pageKey =
    pageKeyCandidate === undefined
      ? application.homePageKey
      : builderKeySchema.safeParse(pageKeyCandidate).success
        ? pageKeyCandidate
        : null;
  if (pageKey === null || !application.pageKeys.includes(pageKey))
    return { kind: "unavailable" as const };

  return { kind: "available" as const, read, application, pageKey };
};
