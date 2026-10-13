import { platformPermissionSource } from "../access/platform-permissions";
import "server-only";

import {
  sameId,
  applicationExperienceStateSchema,
  applicationRootIdSchema,
  applicationShellSchema,
  applicationThemeSchema,
  builderKeySchema,
  identityAuthorityIdSchema,
  identitySessionSchema,
  organizationLauncherEntrySchema,
  isPresentationOnlyApplicationExperience,
  namespacedKeySchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  pageDefinitionSchema,
  pageIdSchema,
  permissionIdSchema,
  revisionSchema,
  roleIdSchema,
  type IdentityAuthorityId,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  readCurrentOrganizationDefaultApplicationAfterAuthorization,
  decideOrganizationAccessBatch,
} from "../access/index";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/index";
import { z } from "zod";
import { createHumanInstalledPageBundleContextLoader } from "./installed-page-bundle-context";
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
            page: pageDefinitionSchema,
          })
          .strict(),
      )
      .max(3)
      .optional(),
    shells: z.array(applicationShellSchema).max(100).optional(),
    theme: applicationThemeSchema.optional(),
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
    page: pageDefinitionSchema,
    shells: z.array(applicationShellSchema).max(1),
    theme: applicationThemeSchema.optional(),
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
      /** The viewer's own display name in this organisation; absent when the account has none. */
      accountDisplayName: z.string().trim().min(1).max(120).optional(),
      applications: z.array(permittedApplicationSchema).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("suspended_super_administrator_account") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({ kind: z.literal("temporarily_unavailable"), cause: z.string().optional() })
    .strict(),
]);

export type PermittedApplication = z.infer<typeof permittedApplicationSchema>;
export type PermittedApplicationsRead = z.infer<typeof permittedApplicationsReadSchema>;
export type ApplicationExperience = z.infer<typeof applicationExperienceSchema>;

type TemporarilyUnavailableApplicationRead = Readonly<{
  kind: "temporarily_unavailable";
  cause?: string;
}>;

const isTemporarilyUnavailableApplicationRead = (
  result: unknown,
): result is TemporarilyUnavailableApplicationRead =>
  result !== null &&
  typeof result === "object" &&
  "kind" in result &&
  result.kind === "temporarily_unavailable";

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

/**
 * Concurrent permitted-application reads per launcher request. With the organisation default read
 * beside them this stays below the default runtime pool of five connections.
 */
const permittedReadConcurrency = 3;

/** Maps in input order with at most `limit` reads in flight; the first failure rejects. */
const mapWithConcurrency = async <Input, Output>(
  inputs: readonly Input[],
  limit: number,
  read: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results = new Array<Output>(inputs.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < inputs.length) {
      const index = next++;
      try {
        results[index] = await read(inputs[index] as Input);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
};

const describeApplicationAddressFailure = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const name = current instanceof Error ? current.name : typeof current;
    const code =
      typeof current === "object" && "code" in current
        ? String((current as { readonly code?: unknown }).code)
        : undefined;
    parts.push(code === undefined ? name : `${name}(${code})`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- ");
};

type AddressRow = Readonly<{ address: unknown }>;
type OrganizationLauncherRow = DatabaseRow & Readonly<{
  organization_id: unknown;
  tenant_short_name: unknown;
  tenant_display_name: unknown;
  organization_short_name: unknown;
  organization_display_name: unknown;
  account_display_name: unknown;
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

/**
 * A page requirement names either a permission from this application's own catalogue or an exact
 * platform administration permission from the shipped platform catalogue. A platform permission is
 * organisation-scoped, so its declaration targets the organisation.
 */
const pageDiscoveryDeclaration = (
  candidate: ApplicationCandidate,
  page: ApplicationCandidate["pages"][number],
): OrganizationAccessDeclaration => {
  const platformDeclaration = platformPermissionSource().forKey(page.accessPermissionKey);
  if (platformDeclaration !== undefined)
    return organizationAccessDeclarationSchema.parse({
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
        ownerId: platformPermissionSource().ownerId,
        permissionId: platformDeclaration.permissionId,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    });
  const matches = candidate.permissions.filter((entry) => entry.key === page.accessPermissionKey);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("APPLICATION_PAGE_PERMISSION_UNAVAILABLE");
  const permission = matches[0];
  return organizationAccessDeclarationSchema.parse({
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
};

/** Projects one application's permitted pages inside the caller's application-scoped request. */
const projectPermittedApplication = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  candidate: ApplicationCandidate,
): Promise<Readonly<{
  application: PermittedApplication;
  experiences: ApplicationExperience[];
}> | null> => {
  const releaseRows = await transaction.query<CurrentReleaseRow>`
    select vortex_definition.is_current_application_address_release(
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
  if (new Set(candidate.pages.map((page) => page.key)).size !== candidate.pages.length)
    throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");

  // Every page of the application is decided by one access query.
  const decisions = await decideOrganizationAccessBatch(
    transaction,
    scope,
    candidate.pages.map((page) => pageDiscoveryDeclaration(candidate, page)),
  );
  const allowedPageKeys = new Set<string>();
  candidate.pages.forEach((page, index) => {
    if (decisions[index]?.allowed === true) allowedPageKeys.add(page.key);
  });

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
};

const permittedApplication = async (
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  candidate: ApplicationCandidate,
): Promise<
  | Readonly<{ application: PermittedApplication; experiences: ApplicationExperience[] }>
  | null
  | Readonly<{ kind: "temporarily_unavailable"; cause?: string }>
> => {
  const result = await requests.run(
    session,
    { organizationId, applicationRootId: candidate.applicationRootId },
    (transaction, scope) => projectPermittedApplication(transaction, scope, candidate),
  );
  if (result.kind === "temporarily_unavailable")
    return {
      kind: "temporarily_unavailable",
      ...(result.cause === undefined ? {} : { cause: result.cause }),
    };
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
): Promise<AddressedApplicationBundleRead> => {
  const unavailable = (): AddressedApplicationBundleRead => ({
    read: { kind: "unavailable" },
    experiences: [],
  });
  const temporarilyUnavailable = (cause?: string): AddressedApplicationBundleRead => ({
    read: {
      kind: "temporarily_unavailable",
      ...(cause === undefined ? {} : { cause }),
    },
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
  const organizationId = organizationIdSchema.safeParse(addressedIdentity.organizationId);
  if (!organizationId.success) return unavailable();

  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: identityAuthorityId.data,
  });
  try {
    // The installed bundle context and the page permission decisions share one request, so the
    // permitted pages are decided against exactly the release that is returned.
    const addressedResult = await requests.run<
      | Readonly<{
          context: InstalledRuntimeContext;
          permitted: NonNullable<Awaited<ReturnType<typeof projectPermittedApplication>>>;
        }>
      | undefined
    >(
      session.data,
      {
        organizationId: organizationId.data,
        applicationRootId: addressedIdentity.identity.applicationRootId,
      },
      async (transaction, scope) => {
        if (scope.applicationRootId === undefined ||
          !sameId(scope.applicationRootId, addressedIdentity.identity.applicationRootId))
          return undefined;
        const context = await createHumanInstalledPageBundleContextLoader({
          transaction,
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
        const permitted = await projectPermittedApplication(
          transaction,
          scope,
          applicationCandidateFromInstalledContext(context),
        );
        return permitted === null ? undefined : { context, permitted };
      },
    );
    if (addressedResult.kind === "temporarily_unavailable")
      return temporarilyUnavailable(addressedResult.cause);
    if (addressedResult.kind !== "available" || addressedResult.value === undefined)
      return unavailable();

    const { context, permitted } = addressedResult.value;
    const read = permittedApplicationsReadSchema.parse({
      kind: "available",
      organizationId: organizationId.data,
      tenantShortName: addressedIdentity.tenantShortName,
      organizationShortName: addressedIdentity.organizationShortName,
      defaultApplicationRootId: null,
      ...(addressedIdentity.accountDisplayName === undefined
        ? {}
        : { accountDisplayName: addressedIdentity.accountDisplayName }),
      applications: [permitted.application],
    });
    return {
      read,
      experiences: permitted.experiences,
      context,
      identity: addressedIdentity.identity,
    };
  } catch (error) {
    return temporarilyUnavailable(describeApplicationAddressFailure(error));
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
        select vortex_definition.resolve_addressed_active_application_identity(
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
  accountDisplayName?: string;
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
      ...(address.accountDisplayName === undefined
        ? {}
        : { accountDisplayName: address.accountDisplayName }),
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
  if (!authorityId.success)
    return { kind: "temporarily_unavailable", cause: "identity_authority_id_invalid" };
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
      if (isTemporarilyUnavailableApplicationRead(permitted))
        return permittedApplicationsReadSchema.parse(permitted);
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

    // The default and each candidate are independent HUMAN requests. They run together, bounded
    // below the runtime pool size, and their outcomes are consulted in the original order.
    const defaultReadRequest = requests.run(
      parsedSession.data,
      { organizationId: read.organizationId },
      (transaction) => readCurrentOrganizationDefaultApplicationAfterAuthorization(transaction),
    );
    void defaultReadRequest.catch(() => undefined);
    const candidateReads = mapWithConcurrency(read.applications, permittedReadConcurrency,
      (candidate) => permittedApplication(requests, parsedSession.data, read.organizationId, candidate));
    void candidateReads.catch(() => undefined);
    const defaultRead = await defaultReadRequest;
    if (defaultRead.kind !== "available") return defaultRead;

    const applications: PermittedApplication[] = [];
    for (const permitted of await candidateReads) {
      if (isTemporarilyUnavailableApplicationRead(permitted))
        return permittedApplicationsReadSchema.parse(permitted);
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
  } catch (error) {
    return { kind: "temporarily_unavailable", cause: describeApplicationAddressFailure(error) };
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
