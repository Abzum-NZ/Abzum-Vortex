import "server-only";

import {
  builderKeySchema,
  namespacedKeySchema,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createPrivateInvalidationChannelAuthorizer,
  type PrivateInvalidationChannelAccess,
  type PrivateInvalidationChannelAccessReader,
  type PrivateInvalidationChannelAuthorizer,
  type PrivateInvalidationTopicScope,
} from "@vortex/event";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { z } from "zod";
import { resolveApplicationAddress } from "./application-address";
import { humanOrganizationRequests } from "./server-composition";
import { resolveIdentitySession } from "../auth/_lib/session-server";

const currentPageAddressSchema = z
  .object({
    tenantShortName: builderKeySchema,
    organizationShortName: builderKeySchema,
    applicationKey: namespacedKeySchema,
    pageKey: builderKeySchema,
  })
  .strict();

type CurrentPageAddress = z.infer<typeof currentPageAddressSchema>;

export type WebPrivateInvalidationChannelInitialResult =
  | Readonly<{
      access: PrivateInvalidationChannelAccess;
      accessTokenExpiresAt: string;
    }>
  | Readonly<{ kind: "unavailable" }>;

export type WebPrivateInvalidationChannelAuthority = Readonly<{
  readInitial(): Promise<WebPrivateInvalidationChannelInitialResult>;
  authorizer: PrivateInvalidationChannelAuthorizer;
}>;

type ResolvedAddressFacts = Readonly<{
  organizationId: OrganizationId;
  currentApplicationRootId: ApplicationRootId;
  currentPageKey: string;
  targetApplicationRootId: ApplicationRootId;
  targetPageKey: string;
}>;

type AuthoritySnapshot = Readonly<{
  access: PrivateInvalidationChannelAccess;
  accessTokenExpiresAt: string;
}>;

const unavailableInitialResult: WebPrivateInvalidationChannelInitialResult = Object.freeze({
  kind: "unavailable",
});

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const isLiveSession = (session: IdentitySession): boolean => {
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
};

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

const readAddressFacts = async (
  session: IdentitySession,
  address: CurrentPageAddress,
  targetApplicationKey: string,
): Promise<ResolvedAddressFacts | undefined> => {
  const currentPage = await resolveApplicationAddress(
    session,
    address.tenantShortName,
    address.organizationShortName,
    address.applicationKey,
    address.pageKey,
  );
  if (
    currentPage.kind !== "application_page" ||
    currentPage.pageKey !== address.pageKey ||
    currentPage.application.key !== address.applicationKey ||
    currentPage.read.tenantShortName !== address.tenantShortName ||
    currentPage.read.organizationShortName !== address.organizationShortName
  )
    return undefined;

  // Omitting pageKey selects the target application's current permitted home page.
  const targetApplication = await resolveApplicationAddress(
    session,
    address.tenantShortName,
    address.organizationShortName,
    targetApplicationKey,
  );
  if (
    targetApplication.kind !== "application_page" ||
    targetApplication.pageKey !== targetApplication.application.homePageKey ||
    targetApplication.application.key !== targetApplicationKey ||
    targetApplication.read.tenantShortName !== address.tenantShortName ||
    targetApplication.read.organizationShortName !== address.organizationShortName ||
    !sameUuid(currentPage.read.organizationId, targetApplication.read.organizationId)
  )
    return undefined;

  return Object.freeze({
    organizationId: currentPage.read.organizationId,
    currentApplicationRootId: currentPage.application.applicationRootId,
    currentPageKey: currentPage.pageKey,
    targetApplicationRootId: targetApplication.application.applicationRootId,
    targetPageKey: targetApplication.pageKey,
  });
};

const matchesSelectedScope = (
  scope: SelectedOrganizationScope,
  organizationId: string,
  applicationRootId: string,
): boolean =>
  sameUuid(scope.organizationId, organizationId) &&
  scope.applicationRootId !== undefined &&
  sameUuid(scope.applicationRootId, applicationRootId) &&
  isPositiveSafeInteger(scope.accessVersion);

const sameSelectedScope = (
  left: SelectedOrganizationScope,
  right: SelectedOrganizationScope,
): boolean =>
  sameUuid(left.tenantId, right.tenantId) &&
  sameUuid(left.organizationId, right.organizationId) &&
  sameUuid(left.organizationAccountId, right.organizationAccountId) &&
  left.applicationRootId !== undefined &&
  right.applicationRootId !== undefined &&
  sameUuid(left.applicationRootId, right.applicationRootId) &&
  left.accessVersion === right.accessVersion;

const sameAddressFacts = (
  left: ResolvedAddressFacts,
  right: ResolvedAddressFacts,
): boolean =>
  sameUuid(left.organizationId, right.organizationId) &&
  sameUuid(left.currentApplicationRootId, right.currentApplicationRootId) &&
  left.currentPageKey === right.currentPageKey &&
  sameUuid(left.targetApplicationRootId, right.targetApplicationRootId) &&
  left.targetPageKey === right.targetPageKey;

/**
 * Creates one request-scoped source of current Web authority for a single private
 * invalidation channel. Selectors are validated once; session and permissions are
 * resolved afresh for every initial read and every Event reauthorization read.
 */
export const createWebPrivateInvalidationChannelAuthority = (
  currentPageAddressInput: unknown,
  targetApplicationKeyInput: unknown,
): WebPrivateInvalidationChannelAuthority => {
  const currentPageAddressResult = (() => {
    try {
      return currentPageAddressSchema.safeParse(currentPageAddressInput);
    } catch {
      // Hostile object inputs, including throwing getters, are neutral unavailable.
      return undefined;
    }
  })();
  const targetApplicationKeyResult = (() => {
    try {
      return namespacedKeySchema.safeParse(targetApplicationKeyInput);
    } catch {
      return undefined;
    }
  })();
  const currentPageAddress = currentPageAddressResult !== undefined &&
    currentPageAddressResult.success
    ? Object.freeze(currentPageAddressResult.data)
    : undefined;
  const targetApplicationKey = targetApplicationKeyResult !== undefined &&
    targetApplicationKeyResult.success
    ? targetApplicationKeyResult.data
    : undefined;

  const readFreshSnapshot = async (): Promise<AuthoritySnapshot | undefined> => {
    if (currentPageAddress === undefined || targetApplicationKey === undefined)
      return undefined;

    try {
      const resolution = await resolveIdentitySession();
      if (resolution.kind !== "active" || !isLiveSession(resolution.session))
        return undefined;
      const session = resolution.session;

      const initialFacts = await readAddressFacts(
        session,
        currentPageAddress,
        targetApplicationKey,
      );
      if (initialFacts === undefined || !isLiveSession(session)) return undefined;

      const targetScope = Object.freeze({
        organizationId: initialFacts.organizationId,
        applicationRootId: initialFacts.targetApplicationRootId,
      });
      const requests = humanOrganizationRequests();
      const accessAResult = await requests.resolve(session, targetScope);
      if (
        accessAResult.kind !== "available" ||
        !matchesSelectedScope(
          accessAResult.value,
          initialFacts.organizationId,
          initialFacts.targetApplicationRootId,
        ) ||
        !isLiveSession(session)
      )
        return undefined;
      const accessA = accessAResult.value;

      const repeatedFacts = await readAddressFacts(
        session,
        currentPageAddress,
        targetApplicationKey,
      );
      if (repeatedFacts === undefined || !sameAddressFacts(initialFacts, repeatedFacts))
        return undefined;

      const installationResult = await requests.run(
        session,
        targetScope,
        async (transaction, checkedScope) => ({
          scope: checkedScope,
          installation: await createActiveApplicationInstallationRepository(
            transaction,
          ).readCurrent(),
        }),
      );
      if (
        installationResult.kind !== "available" ||
        !sameSelectedScope(accessA, installationResult.value.scope) ||
        !sameUuid(
          installationResult.value.installation.organizationId,
          initialFacts.organizationId,
        ) ||
        !sameUuid(
          installationResult.value.installation.applicationRootId,
          initialFacts.targetApplicationRootId,
        ) ||
        !isLiveSession(session)
      )
        return undefined;

      const access: PrivateInvalidationChannelAccess = Object.freeze({
        organizationId: initialFacts.organizationId,
        applicationRootId: initialFacts.targetApplicationRootId,
        accessVersion: accessA.accessVersion,
        accountAvailable: true,
        applicationAvailable: true,
      });
      return Object.freeze({
        access,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
      });
    } catch {
      // Every refused, incomplete, or temporary failure has the same safe result.
      return undefined;
    }
  };

  const accessReader: PrivateInvalidationChannelAccessReader = Object.freeze({
    async readCurrent(request: PrivateInvalidationTopicScope) {
      const snapshot = await readFreshSnapshot();
      if (
        snapshot === undefined ||
        !sameUuid(snapshot.access.organizationId, request.organizationId) ||
        !sameUuid(snapshot.access.applicationRootId, request.applicationRootId)
      )
        return undefined;
      return snapshot.access;
    },
  });

  return Object.freeze({
    async readInitial(): Promise<WebPrivateInvalidationChannelInitialResult> {
      const snapshot = await readFreshSnapshot();
      return snapshot ?? unavailableInitialResult;
    },
    authorizer: createPrivateInvalidationChannelAuthorizer({ accessReader }),
  });
};
