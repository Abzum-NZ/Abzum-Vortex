import type { PlatformPermissionSource } from "../access/platform-permissions";
import "server-only";

import {
  identitySessionSchema,
  type IdentitySession,
  type SelectedOrganizationScope,
} from "../access/identity-access";
import {
  organizationAccessDeclarationSchema,
  type OrganizationAccessDeclaration,
} from "../access/organization-access-decision";
import { applicationExperienceStateSchema } from "../catalogue/catalogues";
import {
  applicationRootIdSchema,
  builderKeySchema,
  identityAuthorityIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  permissionIdSchema,
  revisionSchema,
  roleIdSchema,
  type IdentityAuthorityId,
} from "../catalogue/identifiers";
import { sameId, logRefusal } from "../catalogue/runtime-primitives";
import {
  compiledPageShellId,
  applicationShellSchema,
} from "./application-composition/page-composition";
import { applicationThemeSchema } from "./application-composition/theme";
import {
  isPresentationOnlyApplicationExperience,
  pageDefinitionSchema,
} from "./application-contracts";
import {
  applicationLauncherEntrySchema,
  applicationLauncherReadSchema,
  permittedApplicationSchema,
  permittedApplicationsReadSchema,
  type ApplicationLauncherEntry,
  type ApplicationLauncherRead,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "./application-launcher-read";
import { createHumanOrganizationRequestService } from "../access/human-organization-request";
import { decideOrganizationAccessBatch } from "../access/organization-access-decision-access";
import { readCurrentOrganizationDefaultApplicationAfterAuthorization } from "../access/organization-runtime-settings-administration";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import { z } from "zod";
import { createHumanInstalledPageBundleContextLoader } from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import {
  previewApplicationKey,
  previewInstallationIdOfApplicationKey,
} from "./preview-application-key";

const reservedTenantSegments = new Set(["auth", "health", "signed-in", "signin", "api"]);

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

/**
 * One application experience page the viewer may be shown in place of a page they cannot open:
 * the viewer may open that page itself, it is presentation-only, and it carries only the shell and
 * release theme it renders in.
 */
const applicationExperienceSchema = z
  .object({
    state: applicationExperienceStateSchema,
    page: pageDefinitionSchema,
    shells: z.array(applicationShellSchema).max(1),
    theme: applicationThemeSchema.optional(),
  })
  .strict();

export type ApplicationExperience = z.infer<typeof applicationExperienceSchema>;

const applicationLauncherEntry = (application: PermittedApplication): ApplicationLauncherEntry =>
  applicationLauncherEntrySchema.parse({
    applicationRootId: application.applicationRootId,
    key: application.key,
    name: application.name,
    icon: application.icon,
    homePageKey: application.homePageKey,
  });

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

/**
 * An addressed application the viewer may not open reads as "unavailable" to the browser, so the
 * server log carries the real cause: the eligibility reason code of every page decision.
 */
const logApplicationRefusal = (applicationKey: string, reasonCodes: readonly string[]): void =>
  logRefusal(
    "application-address",
    `application ${applicationKey}`,
    reasonCodes.length === 0
      ? "APPLICATION_HAS_NO_PAGE"
      : `APPLICATION_ACCESS_${reasonCodes.join("+").toUpperCase()}`,
  );

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
const addressedOrganizationSchema = z
  .object({
    organization_id: organizationIdSchema,
    account_display_name: z.string().trim().min(1).max(120).nullable(),
  })
  .strict();
type AddressedOrganizationRow = DatabaseRow &
  Readonly<{
    organization_id: unknown;
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

const addressedActiveApplicationIdentitySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    definitionKey: namespacedKeySchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

/** An addressed Application: its active installation, or the preview of its draft. */
type AddressedActiveApplicationIdentity =
  | (z.infer<typeof addressedActiveApplicationIdentitySchema> & {
      previewInstallationId?: never;
      holdsLiveRecords?: never;
    })
  | (Omit<
      z.infer<typeof addressedActiveApplicationIdentitySchema>,
      "applicationReleaseRevision"
    > & {
      previewInstallationId: string;
      /** Whether the preview was seeded with copies of live records. */
      holdsLiveRecords: boolean;
      applicationReleaseRevision?: never;
    });

/**
 * A page requirement names either a permission from this application's own catalogue or an exact
 * platform administration permission from the shipped platform catalogue. A platform permission is
 * organisation-scoped, so its declaration targets the organisation.
 */
const pageDiscoveryDeclaration = (
  permissions: PlatformPermissionSource,
  candidate: ApplicationCandidate,
  page: ApplicationCandidate["pages"][number],
): OrganizationAccessDeclaration => {
  const platformDeclaration = permissions.forKey(page.accessPermissionKey);
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
        ownerId: permissions.ownerId,
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

/**
 * The launcher's per-application projection, remembered between requests. An entry is keyed by the
 * person's organisation account, the organisation access version and the installed release, so it
 * is never shared across people or access versions: any access change moves the version and the
 * next navigation decides again. The access version does not move when a time-bound assignment
 * lapses, so an entry also ends at the earliest decision expiry and after `launcherProjectionTtlMs`.
 */
const launcherProjectionTtlMs = 30_000;
const launcherProjectionLimit = 512;
const launcherProjections = new Map<
  string,
  Readonly<{ application: ApplicationLauncherEntry; expiresAtMs: number }>
>();

const launcherProjectionKey = (
  identityId: string,
  scope: SelectedOrganizationScope,
  candidate: ApplicationCandidate,
): string =>
  [
    identityId,
    scope.organizationId,
    scope.organizationAccountId,
    scope.accessVersion,
    candidate.applicationRootId,
    candidate.releaseRevision,
  ]
    .join("|")
    .toLowerCase();

const recallLauncherProjection = (key: string): ApplicationLauncherEntry | undefined => {
  const entry = launcherProjections.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    launcherProjections.delete(key);
    return undefined;
  }
  return entry.application;
};

const rememberLauncherProjection = (
  key: string,
  application: ApplicationLauncherEntry,
  validUntil: string | undefined,
): void => {
  const now = Date.now();
  const expiresAtMs = Math.min(
    now + launcherProjectionTtlMs,
    validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(validUntil),
  );
  if (!(expiresAtMs > now)) return;
  for (const [entryKey, entry] of launcherProjections)
    if (entry.expiresAtMs <= now) launcherProjections.delete(entryKey);
  while (launcherProjections.size >= launcherProjectionLimit) {
    const oldest = launcherProjections.keys().next();
    if (oldest.done === true) break;
    launcherProjections.delete(oldest.value);
  }
  launcherProjections.set(key, { application, expiresAtMs });
};

/** Projects one application's permitted pages inside the caller's application-scoped request. */
const projectPermittedApplication = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  candidate: ApplicationCandidate,
  remember?: (application: PermittedApplication | null, validUntil: string | undefined) => void,
  refused?: (reasonCodes: readonly string[]) => void,
  addressedPageKey?: string,
  launcher = false,
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

  if (new Set(candidate.pages.map((page) => page.key)).size !== candidate.pages.length)
    throw new Error("APPLICATION_PAGE_ADDRESS_UNAVAILABLE");

  const addressedPage =
    addressedPageKey === undefined
      ? undefined
      : candidate.pages.find((page) => page.key === addressedPageKey);
  if (addressedPageKey !== undefined && addressedPage === undefined) return null;

  // A placement refresh needs its page and an open application home, not the navigation's full
  // page list. Shared permission requirements still take only one decision in this request.
  const decisions = new Map<
    string,
    Awaited<ReturnType<typeof decideOrganizationAccessBatch>>[number]
  >();
  const decidePages = async (pages: readonly ApplicationCandidate["pages"][number][]) => {
    const requirements = new Map(
      pages
        .filter((page) => !decisions.has(page.accessPermissionKey))
        .map((page) => [page.accessPermissionKey, page]),
    );
    if (requirements.size === 0) return;
    const results = await decideOrganizationAccessBatch(
      transaction,
      scope,
      [...requirements.values()].map((page) =>
        pageDiscoveryDeclaration(permissions, candidate, page),
      ),
    );
    [...requirements.keys()].forEach((key, index) => {
      decisions.set(key, results[index]!);
    });
  };
  await decidePages(
    launcher
      ? candidate.pages.filter((page) => page.key === candidate.homePageKey)
      : addressedPage === undefined
        ? candidate.pages
        : candidate.pages.filter(
            (page) => page.key === addressedPage.key || page.key === candidate.homePageKey,
          ),
  );
  // Role homes need the current role IDs. They are read once, on first use, and both uses below
  // run only after the release home is refused, so an allowed release home never reads them.
  const readRoleHomes = async () => {
    const roleRows = await transaction.query<SourceRoleRow>`
      select source_role_id from vortex_access.read_current_application_role_ids_for_launcher()
    `;
    const activeRoleIds = new Set(
      roleRows.map((row) => roleIdSchema.parse(row.source_role_id).toLowerCase()),
    );
    return [...candidate.roles]
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .filter((role) => activeRoleIds.has(role.roleId.toLowerCase()))
      .map((role) => candidate.pages.find((page) => sameId(page.pageId, role.homePageId)))
      .filter((page) => page !== undefined);
  };
  let roleHomeRead: ReturnType<typeof readRoleHomes> | undefined;
  const roleHomes = () => {
    roleHomeRead ??= readRoleHomes();
    return roleHomeRead;
  };
  const pageAllowed = (page: ApplicationCandidate["pages"][number]) =>
    decisions.get(page.accessPermissionKey)?.allowed === true;
  if (addressedPage !== undefined || launcher) {
    if (addressedPage !== undefined && !pageAllowed(addressedPage)) {
      const reasonCode = decisions.get(addressedPage.accessPermissionKey)?.reasonCode;
      refused?.(reasonCode === undefined ? [] : [reasonCode]);
      return null;
    }
    if (!candidate.pages.some((page) => page.key === candidate.homePageKey && pageAllowed(page))) {
      // Preserve the existing role-home order when the release home is refused. Decide another
      // home only as needed; a current role's already-allowed addressed page needs no extra read.
      for (const page of await roleHomes()) {
        await decidePages([page]);
        if (pageAllowed(page)) break;
      }
    }
  }
  const allowedRequirementKeys = new Set<string>();
  let validUntil: string | undefined;
  decisions.forEach((decision, requirementKey) => {
    if (decision?.allowed !== true) return;
    allowedRequirementKeys.add(requirementKey);
    if (
      decision.validUntil !== undefined &&
      (validUntil === undefined || decision.validUntil < validUntil)
    )
      validUntil = decision.validUntil;
  });
  const allowedPageKeys = new Set<string>();
  for (const page of candidate.pages)
    if (allowedRequirementKeys.has(page.accessPermissionKey)) allowedPageKeys.add(page.key);

  // The release home wins if authorised. Otherwise use the lowest source
  // role key among current application roles with an open home. With no page open, no role home
  // can be chosen, so the role IDs are not read.
  const homePageKey = allowedPageKeys.has(candidate.homePageKey)
    ? candidate.homePageKey
    : allowedPageKeys.size === 0
      ? undefined
      : (await roleHomes()).find((page) => allowedPageKeys.has(page.key))?.key;
  // A home chosen from current role assignments depends on time-bound assignments, memberships and
  // activations that the page decisions' expiry does not cover, so only a projection that does not
  // depend on them is remembered.
  const rememberable =
    addressedPageKey === undefined &&
    (allowedPageKeys.has(candidate.homePageKey) || (!launcher && allowedPageKeys.size === 0));
  if (homePageKey === undefined) {
    if (rememberable) remember?.(null, validUntil);
    refused?.(
      [...new Set([...decisions.values()].flatMap((decision) => decision.reasonCode ?? []))].sort(),
    );
    return null;
  }

  // An experience page is offered only when the viewer may open that page itself and it is
  // presentation-only, so it can never show gated, conditional or data-bound content.
  const shells = candidate.shells ?? [];
  const experiences = (
    !launcher && addressedPageKey === undefined ? (candidate.experiences ?? []) : []
  )
    .filter(
      (experience) =>
        allowedPageKeys.has(experience.page.key) &&
        isPresentationOnlyApplicationExperience(experience.page, shells),
    )
    .map((experience) => {
      const composition = experience.page.composition;
      const shellId = compiledPageShellId(composition) ?? undefined;
      return applicationExperienceSchema.parse({
        state: experience.state,
        page: experience.page,
        shells:
          shellId === undefined ? [] : shells.filter((shell) => sameId(shell.shellId, shellId)),
        ...(candidate.theme === undefined ? {} : { theme: candidate.theme }),
      });
    });

  const application = permittedApplicationSchema.parse({
    applicationRootId: candidate.applicationRootId,
    key: candidate.key,
    name: candidate.name,
    icon: candidate.icon,
    homePageKey,
    pageKeys: [...allowedPageKeys].sort(),
  });
  if (rememberable) remember?.(application, validUntil);
  return { application, experiences };
};

const permittedApplication = async (
  permissions: PlatformPermissionSource,
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  candidate: ApplicationCandidate,
  remember?: (
    scope: SelectedOrganizationScope,
    application: PermittedApplication | null,
    validUntil: string | undefined,
  ) => void,
  refused?: (reasonCodes: readonly string[]) => void,
  launcher = false,
): Promise<
  | Readonly<{ application: PermittedApplication; experiences: ApplicationExperience[] }>
  | null
  | Readonly<{ kind: "temporarily_unavailable"; cause?: string }>
> => {
  const result = await requests.run(
    session,
    { organizationId, applicationRootId: candidate.applicationRootId },
    (transaction, scope) =>
      projectPermittedApplication(
        permissions,
        transaction,
        scope,
        candidate,
        (application, validUntil) => remember?.(scope, application, validUntil),
        refused,
        undefined,
        launcher,
      ),
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
export function readPermittedApplicationsAtAddress(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
): Promise<ApplicationLauncherRead>;
export function readPermittedApplicationsAtAddress(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<PermittedApplicationsRead>;
export async function readPermittedApplicationsAtAddress(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate?: string,
): Promise<PermittedApplicationsRead | ApplicationLauncherRead> {
  if (applicationKeyCandidate === undefined)
    return readPermittedApplications(
      permissions,
      session,
      tenantShortNameCandidate,
      organizationShortNameCandidate,
      identityAuthorityIdCandidate,
      undefined,
      () => {},
    );
  return (
    await readAtAddress(
      permissions,
      session,
      tenantShortNameCandidate,
      organizationShortNameCandidate,
      identityAuthorityIdCandidate,
      applicationKeyCandidate,
    )
  ).read;
}

/**
 * The addressed page read with the addressed application's experience pages. They are returned
 * only while the viewer may open that application, so an unknown or refused application never
 * discloses any of its content.
 */
export const readAddressedApplicationAtAddress = (
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<AddressedApplicationRead> =>
  readAtAddress(
    permissions,
    session,
    tenantShortNameCandidate,
    organizationShortNameCandidate,
    identityAuthorityIdCandidate,
    applicationKeyCandidate,
  );

/**
 * Resolves one addressed App from the current HUMAN installed bundle and page authority.
 * A page key limits authority to a placement refresh: its page and the application home only.
 * That projection must not feed a full page, navigation, launcher or experience render.
 */
export const readAddressedApplicationFromInstalledBundleAtAddress = async (
  permissions: PlatformPermissionSource,
  sessionCandidate: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
  addressedPageKeyCandidate?: string,
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
  if (
    addressedPageKeyCandidate !== undefined &&
    !builderKeySchema.safeParse(addressedPageKeyCandidate).success
  )
    return unavailable();

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
        ...(addressedIdentity.identity.previewInstallationId === undefined
          ? {}
          : { previewInstallationId: addressedIdentity.identity.previewInstallationId }),
      },
      async (transaction, scope) => {
        if (
          scope.applicationRootId === undefined ||
          !sameId(scope.applicationRootId, addressedIdentity.identity.applicationRootId)
        )
          return undefined;
        const context = await createHumanInstalledPageBundleContextLoader({
          transaction,
          scope: {
            organizationId: scope.organizationId,
            organizationAccountId: scope.organizationAccountId,
            applicationRootId: scope.applicationRootId,
            ...(scope.previewInstallationId === undefined
              ? {}
              : { previewInstallationId: scope.previewInstallationId }),
          },
        }).load();
        const application = context.releaseSet.application;
        const identity = addressedIdentity.identity;
        if (
          !sameId(context.organizationId, addressedIdentity.organizationId) ||
          !sameId(context.applicationRootId, identity.applicationRootId) ||
          (identity.previewInstallationId === undefined &&
            application.releaseRevision !== identity.applicationReleaseRevision) ||
          application.definitionKey !== identity.definitionKey ||
          application.releaseRevision !== context.applicationReleaseRevision
        )
          return undefined;
        const permitted = await projectPermittedApplication(
          permissions,
          transaction,
          scope,
          applicationCandidateFromInstalledContext(context),
          undefined,
          (reasonCodes) => logApplicationRefusal(application.definitionKey, reasonCodes),
          addressedPageKeyCandidate,
        );
        return permitted === null ? undefined : { context, permitted };
      },
    );
    if (addressedResult.kind === "temporarily_unavailable")
      return temporarilyUnavailable(addressedResult.cause);
    if (addressedResult.kind !== "available" || addressedResult.value === undefined)
      return unavailable();

    const { context, permitted } = addressedResult.value;
    // A preview is addressed, linked and navigated by its own key, never the installed one.
    const previewInstallationId = addressedIdentity.identity.previewInstallationId;
    const application =
      previewInstallationId === undefined
        ? permitted.application
        : permittedApplicationSchema.parse({
            ...permitted.application,
            key: previewApplicationKey(previewInstallationId),
            previewInstallationId,
          });
    const read = permittedApplicationsReadSchema.parse({
      kind: "available",
      organizationId: organizationId.data,
      tenantShortName: addressedIdentity.tenantShortName,
      organizationShortName: addressedIdentity.organizationShortName,
      defaultApplicationRootId: null,
      ...(addressedIdentity.accountDisplayName === undefined
        ? {}
        : { accountDisplayName: addressedIdentity.accountDisplayName }),
      applications: [application],
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
const readAddressedActiveApplicationIdentity = async (
  sessionCandidate: IdentitySession,
  organizationIdCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<AddressedActiveApplicationIdentity | undefined> => {
  const session = identitySessionSchema.safeParse(sessionCandidate);
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const identityAuthorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  const applicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
  if (
    !session.success ||
    !organizationId.success ||
    !identityAuthorityId.success ||
    !applicationKey.success
  )
    return undefined;
  const previewInstallationId = previewInstallationIdOfApplicationKey(applicationKey.data);
  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: identityAuthorityId.data,
  });
  const result = await requests.runChangeWithRefusal(
    session.data,
    { organizationId: organizationId.data },
    async (transaction, scope) => {
      if (scope.applicationRootId !== undefined)
        throw new Error("APPLICATION_ADDRESS_SCOPE_UNAVAILABLE");
      if (previewInstallationId !== undefined) {
        const { readPreviewApplicationIdentity } =
          await import("./preview-installation-repository");
        // A preview address names the preview; only a builder of its Application may open it.
        const preview = await readPreviewApplicationIdentity(
          transaction,
          previewInstallationId,
        ).catch((error: unknown) => {
          logRefusal("application-address", "preview identity", "PREVIEW_ADDRESS_REFUSED", error);
          return undefined;
        });
        if (preview === undefined || !sameId(preview.organizationId, organizationId.data))
          return undefined;
        return {
          organizationId: preview.organizationId,
          applicationRootId: preview.applicationRootId,
          definitionKey: preview.definitionKey,
          previewInstallationId: preview.previewInstallationId,
          holdsLiveRecords: preview.seededRecordTypeIds.length > 0,
        };
      }
      const rows = await transaction.query<AddressedIdentityRow>`
        select vortex_definition.resolve_addressed_active_application_identity(
          ${applicationKey.data}::text
        ) as addressed_identity
      `;
      if (rows.length !== 1 || rows[0] === undefined)
        throw new Error("APPLICATION_ADDRESS_IDENTITY_UNAVAILABLE");
      const identity = addressedActiveApplicationIdentitySchema.safeParse(
        rows[0].addressed_identity,
      );
      if (
        !identity.success ||
        identity.data.organizationId !== organizationId.data ||
        identity.data.definitionKey !== applicationKey.data
      )
        throw new Error("APPLICATION_ADDRESS_IDENTITY_UNAVAILABLE");
      return identity.data;
    },
    // An address that names no application here is an answer, not a platform failure.
    (code) => (code === "P0002" ? null : undefined),
  );
  if (result.kind !== "available" || result.value === undefined || result.value === null)
    return undefined;
  const identity: AddressedActiveApplicationIdentity = result.value;
  // A preview holding copies of live records opens only once they are decided again by the
  // builder's current live access in the installed Application; a refusal refuses the preview.
  if (identity.previewInstallationId !== undefined && identity.holdsLiveRecords) {
    const previewInstallationId = identity.previewInstallationId;
    const reconciled = await requests.run(
      session.data,
      { organizationId: organizationId.data, applicationRootId: identity.applicationRootId },
      async (transaction) => {
        const { reconcilePreviewInstallation } = await import("./preview-installation-repository");
        await reconcilePreviewInstallation(transaction, previewInstallationId);
        return true;
      },
    );
    if (reconciled.kind !== "available") {
      logRefusal("application-address", "preview records", "PREVIEW_RECORDS_UNCHECKED", reconciled);
      return undefined;
    }
  }
  return identity;
};

/** Resolves an address to a thin current active identity before any Application-scoped read. */
const readAddressedApplicationIdentityAtAddress = async (
  sessionCandidate: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<
  | Readonly<{
      organizationId: string;
      tenantShortName: string;
      organizationShortName: string;
      accountDisplayName?: string;
      identity: AddressedActiveApplicationIdentity;
    }>
  | undefined
> => {
  const session = identitySessionSchema.safeParse(sessionCandidate);
  const tenantShortName = builderKeySchema.safeParse(tenantShortNameCandidate);
  const organizationShortName = builderKeySchema.safeParse(organizationShortNameCandidate);
  const identityAuthorityId = identityAuthorityIdSchema.safeParse(identityAuthorityIdCandidate);
  const applicationKey = namespacedKeySchema.safeParse(applicationKeyCandidate);
  if (
    !session.success ||
    !tenantShortName.success ||
    !organizationShortName.success ||
    !identityAuthorityId.success ||
    !applicationKey.success ||
    isReservedTenantSegment(tenantShortNameCandidate) ||
    Date.parse(session.data.accessTokenExpiresAt) <= Date.now()
  )
    return undefined;

  try {
    const rows = await withRuntimeTransaction(
      async (transaction) =>
        transaction.query<AddressedOrganizationRow>`
        select *
        from vortex_identity.read_organization_at_address(
          ${session.data.identityId}::uuid,
          ${tenantShortName.data}::text,
          ${organizationShortName.data}::text
        )
      `,
    );
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) throw new Error("ORGANIZATION_ADDRESS_NOT_UNIQUE");
    const address = addressedOrganizationSchema.parse(rows[0]);
    const identity = await readAddressedActiveApplicationIdentity(
      session.data,
      address.organization_id,
      identityAuthorityId.data,
      applicationKey.data,
    );
    if (
      identity === undefined ||
      identity.organizationId !== address.organization_id ||
      (identity.previewInstallationId === undefined
        ? identity.definitionKey !== applicationKey.data
        : previewApplicationKey(identity.previewInstallationId) !== applicationKey.data)
    )
      return undefined;
    return Object.freeze({
      organizationId: address.organization_id,
      tenantShortName: tenantShortName.data,
      organizationShortName: organizationShortName.data,
      ...(address.account_display_name === null
        ? {}
        : { accountDisplayName: address.account_display_name }),
      identity,
    });
  } catch (error) {
    logRefusal(
      "application-address",
      `application ${applicationKey.data} identity`,
      "APPLICATION_IDENTITY_READ_FAILED",
      error,
    );
    return undefined;
  }
};

const readAtAddress = async (
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
): Promise<AddressedApplicationRead> => {
  let experiences: readonly ApplicationExperience[] = [];
  const read = await readPermittedApplications(
    permissions,
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

function readPermittedApplications(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string,
  receiveExperiences: (experiences: readonly ApplicationExperience[]) => void,
): Promise<PermittedApplicationsRead>;
function readPermittedApplications(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: undefined,
  receiveExperiences: (experiences: readonly ApplicationExperience[]) => void,
): Promise<ApplicationLauncherRead>;
async function readPermittedApplications(
  permissions: PlatformPermissionSource,
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
  identityAuthorityIdCandidate: IdentityAuthorityId,
  applicationKeyCandidate: string | undefined,
  receiveExperiences: (experiences: readonly ApplicationExperience[]) => void,
): Promise<PermittedApplicationsRead | ApplicationLauncherRead> {
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
          ${organizationShortName.data}::text,
          ${addressedApplicationKey !== undefined}::boolean
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
        permissions,
        requests,
        parsedSession.data,
        read.organizationId,
        candidate,
        undefined,
        (reasonCodes) => logApplicationRefusal(candidate.key, reasonCodes),
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

    // The organisation request reads the default and the access version this person holds now.
    // Each application is then recalled for exactly that version or decided again; the decisions
    // of the applications that are not recalled run together, bounded below the runtime pool size.
    const defaultRead = await requests.run(
      parsedSession.data,
      { organizationId: read.organizationId },
      async (transaction, scope) => ({
        scope,
        configuredDefault:
          await readCurrentOrganizationDefaultApplicationAfterAuthorization(transaction),
      }),
    );
    if (defaultRead.kind !== "available") return defaultRead;
    const organizationScope = defaultRead.value.scope;
    const recalled = read.applications.map((candidate) =>
      recallLauncherProjection(
        launcherProjectionKey(parsedSession.data.identityId, organizationScope, candidate),
      ),
    );
    const decided = await mapWithConcurrency(
      read.applications.filter((_candidate, index) => recalled[index] === undefined),
      permittedReadConcurrency,
      (candidate) =>
        permittedApplication(
          permissions,
          requests,
          parsedSession.data,
          read.organizationId,
          candidate,
          (scope, application, validUntil) =>
            application === null
              ? undefined
              : rememberLauncherProjection(
                  launcherProjectionKey(parsedSession.data.identityId, scope, candidate),
                  applicationLauncherEntry(application),
                  validUntil,
                ),
          undefined,
          true,
        ),
    );

    const applications: ApplicationLauncherEntry[] = [];
    let decidedIndex = 0;
    for (const recall of recalled) {
      if (recall !== undefined) {
        applications.push(recall);
        continue;
      }
      const permitted = decided[decidedIndex++];
      if (permitted === undefined || permitted === null) continue;
      if (isTemporarilyUnavailableApplicationRead(permitted))
        return applicationLauncherReadSchema.parse(permitted);
      applications.push(applicationLauncherEntry(permitted.application));
    }
    const configuredDefault = defaultRead.value.configuredDefault;
    const defaultApplicationRootId =
      configuredDefault !== null &&
      applications.some((entry) => sameId(entry.applicationRootId, configuredDefault))
        ? configuredDefault
        : null;
    return applicationLauncherReadSchema.parse({
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
}

/** A browser address selects only from the currently permitted server projection. */
export const resolvePermittedApplicationAddress = (
  read: PermittedApplicationsRead,
  applicationKeyCandidate: string,
  pageKeyCandidate?: string,
) => {
  if (read.kind !== "available") return read;
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
