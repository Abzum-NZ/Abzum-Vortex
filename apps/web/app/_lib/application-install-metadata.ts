import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  databaseTimestamp, fingerprintSchema, organizationAccessDeclarationSchema, revisionSchema,
  sameId, sessionContextSchema, timestampSchema,
  type IdentitySession, type OrganizationAccessDeclaration, type SelectedOrganizationScope,
} from "@vortex/contracts";
import { runOrganizationAccessOperation } from "@vortex/access";
import {
  applicationInstallAddressSchema, createApplicationInstallManifest,
  createHumanInstalledRuntimeContextLoader,
  type ApplicationInstallAddress, type ApplicationInstallManifest, type InstalledRuntimeContext,
} from "@vortex/app";
import { withRequestDatabaseLifetime, type DatabaseRow, type RequestDatabaseLifetime,
  type RequestDatabaseTransaction } from "@vortex/db";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/modules";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { resolveApplicationAddress } from "./application-address";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { createApplicationInstallIcon } from "./application-install-icon";

const expectationSchema = z.object({ applicationReleaseRevision: revisionSchema,
  snapshot: fingerprintSchema }).strict();
export type ApplicationInstallExpectation = z.infer<typeof expectationSchema>;
export type ApplicationInstallResult =
  | Readonly<{ kind: "unavailable" | "temporarily_unavailable" }>
  | Readonly<{ kind: "available"; manifest: ApplicationInstallManifest; manifestUrl: string;
      snapshot: string; applicationReleaseRevision: number; validUntil: string }>;
class InstallRefused extends Error {}
const refused = (): never => { throw new InstallRefused(); };
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const sessionFacts = (session: IdentitySession) => [session.identityId, session.sessionId,
  session.authenticationStrength, session.accessTokenIssuedAt, session.accessTokenExpiresAt,
  session.primaryAuthenticatedAt ?? null, session.multiFactorAuthenticatedAt ?? null];

const releaseFacts = (context: InstalledRuntimeContext) => ({
  organizationId: context.organizationId, applicationRootId: context.applicationRootId,
  applicationReleaseRevision: context.applicationReleaseRevision,
  application: [context.releaseSet.application.rootId, context.releaseSet.application.releaseRevision,
    context.releaseSet.application.contentFingerprint, context.releaseSet.application.resolutionFingerprint],
  modules: context.releaseSet.modules.map((module) => [module.rootId, module.releaseRevision,
    module.contentFingerprint, module.resolutionFingerprint]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  bindings: context.installation.moduleBindings.map((binding) => [binding.organizationId,
    binding.applicationRootId, binding.moduleRootId, binding.bindingRevision,
    binding.applicationReleaseRevision, binding.moduleReleaseRevision, binding.state])
    .sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
});

const homeDeclaration = (context: InstalledRuntimeContext, homeKey: string): OrganizationAccessDeclaration => {
  const pages = context.releaseSet.application.content.pages.filter((page) => page.key === homeKey);
  if (pages.length !== 1 || pages[0] === undefined) return refused();
  const key = pages[0].accessPermissionKey;
  const platform = platformPermissionFor(key);
  if (platform !== undefined) return organizationAccessDeclarationSchema.parse({
    operationKey: "application.page.discover",
    action: { actionKind: platform.actionKind,
      ...(platform.namedAction === undefined ? {} : { namedAction: platform.namedAction }) },
    target: { kind: "organization" },
    requiredPermission: { ownerKind: "platform", ownerId: platformPermissionOwnerId,
      permissionId: platform.permissionId }, recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });
  const matches = context.permissionRegistration.entries.filter((entry) => entry.permission.key === key);
  const entry = matches[0];
  if (matches.length !== 1 || entry === undefined) return refused();
  return organizationAccessDeclarationSchema.parse({
    operationKey: "application.page.discover",
    action: { actionKind: entry.permission.actionKind,
      ...(entry.permission.namedAction === undefined ? {} : { namedAction: entry.permission.namedAction }) },
    target: { kind: "application", applicationRootId: context.applicationRootId },
    requiredPermission: { applicationRootId: context.applicationRootId, ownerKind: entry.ownerKind,
      ownerId: entry.ownerId, permissionId: entry.permission.permissionId },
    recentAuthentication: { kind: "none" }, authority: { kind: "permission" },
  });
};

/** Current protected transport and DB clock, never caller-owned identity or scope. */
const readHuman = async (transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope,
  session: IdentitySession, issuedAt: string, deadline: number) => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as request_context,
      pg_catalog.clock_timestamp() as checked_at
  `;
  const row = rows[0];
  const transport = z.record(z.string(), z.unknown()).safeParse(row?.request_context);
  if (rows.length !== 1 || !transport.success || transport.data.channel !== "web") return refused();
  const parsed = sessionContextSchema.safeParse(Object.fromEntries(
    Object.entries(transport.data).filter(([key]) => key !== "channel"),
  ));
  const checked = timestampSchema.safeParse(databaseTimestamp(row?.checked_at));
  if (!parsed.success || parsed.data.callerKind !== "human" || !checked.success) return refused();
  const context = parsed.data;
  const now = Date.parse(checked.data);
  if (context.delegatedContext !== undefined || context.supportContext !== undefined ||
      scope.applicationRootId === undefined || context.applicationRootId === undefined ||
      !sameId(context.tenantId, scope.tenantId) || !sameId(context.organizationId, scope.organizationId) ||
      !sameId(context.organizationAccountId, scope.organizationAccountId) ||
      !sameId(context.applicationRootId, scope.applicationRootId) || context.accessVersion !== scope.accessVersion ||
      !sameId(context.identityId, session.identityId) || !sameId(context.sessionId, session.sessionId) ||
      context.authenticationStrength !== session.authenticationStrength || context.issuedAt !== issuedAt ||
      context.expiresAt !== session.accessTokenExpiresAt ||
      context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
      context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
      context.accessTokenIssuedAt !== (session.primaryAuthenticatedAt !== undefined ||
        session.multiFactorAuthenticatedAt !== undefined ? session.accessTokenIssuedAt : undefined) ||
      Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
      Date.parse(context.issuedAt) >= Date.parse(context.expiresAt) || now >= deadline) return refused();
  return context;
};

const readCurrent = async (address: ApplicationInstallAddress, lifetime: RequestDatabaseLifetime) => {
  lifetime.checkpoint();
  const identity = await resolveIdentitySession();
  if (identity.kind !== "active") return { kind: identity.kind === "temporarily_unavailable"
    ? "temporarily_unavailable" as const : "unavailable" as const };
  const resolved = await resolveApplicationAddress(identity.session, address.tenantShortName,
    address.organizationShortName, address.applicationKey);
  if (resolved.kind !== "application_page") return { kind: resolved.kind === "temporarily_unavailable"
    ? "temporarily_unavailable" as const : "unavailable" as const };
  if (resolved.application.key !== address.applicationKey ||
      resolved.read.tenantShortName !== address.tenantShortName ||
      resolved.read.organizationShortName !== address.organizationShortName) return refused();
  let explicitRefusal = false;
  const deny = (): never => { explicitRefusal = true; return refused(); };
  const result = await humanOrganizationRequests().run(identity.session, {
    organizationId: resolved.read.organizationId, applicationRootId: resolved.application.applicationRootId,
  }, async (transaction, scope, issuedAt) => {
    try {
      lifetime.checkpoint();
      const human = await readHuman(transaction, scope, identity.session, issuedAt, lifetime.deadline);
      const load = () => createHumanInstalledRuntimeContextLoader({
        activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
        releaseSetReader: createDatabaseApplicationBoundReleaseSetService(installedReleaseCatalogue, transaction),
        scope: { organizationId: resolved.read.organizationId,
          applicationRootId: resolved.application.applicationRootId },
      }).load().catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (["INSTALLED_RUNTIME_CONTEXT_REFUSED", "INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE",
          "INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED"].includes(code)) explicitRefusal = true;
        throw error;
      });
      const initial = await load();
      const initialRelease = digest(releaseFacts(initial));
      const declaration = homeDeclaration(initial, resolved.application.homePageKey);
      const access = await runOrganizationAccessOperation(transaction, scope, declaration, async (decision) => {
        const current = await load();
        if (digest(releaseFacts(current)) !== initialRelease ||
            current.releaseSet.application.definitionKey !== address.applicationKey) return deny();
        let manifest: ApplicationInstallManifest;
        try { manifest = createApplicationInstallManifest(current, address, createApplicationInstallIcon(current)); }
        catch { return deny(); }
        // Re-evaluate the same current permission after icon/manifest derivation.
        const completion = await runOrganizationAccessOperation(transaction, scope,
          homeDeclaration(current, resolved.application.homePageKey), async (finalDecision) => {
            const final = await load();
            if (digest(releaseFacts(final)) !== initialRelease) return deny();
            const finalHuman = await readHuman(transaction, scope, identity.session, issuedAt, lifetime.deadline)
              .catch((error: unknown) => { if (error instanceof InstallRefused) explicitRefusal = true; throw error; });
            if (JSON.stringify(finalHuman) !== JSON.stringify(human)) return deny();
            const clocks = await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as completed_at`;
            const completed = timestampSchema.safeParse(databaseTimestamp(clocks[0]?.completed_at));
            const expiry = Math.min(Date.parse(identity.session.accessTokenExpiresAt),
              Date.parse(decision.validUntil), Date.parse(finalDecision.validUntil), lifetime.deadline);
            if (clocks.length !== 1 || !completed.success || !Number.isFinite(expiry) ||
                Date.parse(completed.data) >= expiry) return deny();
            lifetime.checkpoint();
            return { manifest, snapshot: initialRelease, applicationReleaseRevision: final.applicationReleaseRevision,
              validUntil: new Date(expiry).toISOString(),
              facts: digest([sessionFacts(identity.session), scope.tenantId, scope.organizationId,
                scope.organizationAccountId, scope.applicationRootId, scope.accessVersion,
                resolved.application.homePageKey, initialRelease]) };
          });
        if (completion.outcome !== "completed") return deny();
        return completion.value;
      });
      if (access.outcome !== "completed") return deny();
      return access.value;
    } catch (error) {
      if (error instanceof InstallRefused) explicitRefusal = true;
      throw error;
    }
  });
  lifetime.checkpoint();
  if (result.kind !== "available") return { kind: explicitRefusal || result.kind === "unavailable"
    ? "unavailable" as const : "temporarily_unavailable" as const };
  return { kind: "available" as const, ...result.value };
};

export const loadApplicationInstallMetadata = async (
  candidate: unknown, expectedCandidate?: unknown, signal: AbortSignal = new AbortController().signal,
): Promise<ApplicationInstallResult> => {
  const address = applicationInstallAddressSchema.safeParse(candidate);
  const expected = expectedCandidate === undefined ? undefined : expectationSchema.safeParse(expectedCandidate);
  if (!address.success || (expected !== undefined && !expected.success)) return { kind: "unavailable" };
  try {
    return await withRequestDatabaseLifetime({ signal, deadline: Date.now() + 15_000 }, async (lifetime) => {
      const initial = await readCurrent(address.data, lifetime);
      if (initial.kind !== "available") return initial;
      if (expected?.success && (expected.data.snapshot !== initial.snapshot ||
          expected.data.applicationReleaseRevision !== initial.applicationReleaseRevision)) return { kind: "unavailable" };
      const final = await readCurrent(address.data, lifetime);
      if (final.kind !== "available") return final;
      if (final.facts !== initial.facts || final.snapshot !== initial.snapshot) return { kind: "unavailable" };
      const validUntil = new Date(Math.min(Date.parse(initial.validUntil), Date.parse(final.validUntil))).toISOString();
      if (Date.now() >= Date.parse(validUntil)) return { kind: "unavailable" };
      const query = new URLSearchParams({ ...address.data,
        applicationReleaseRevision: String(final.applicationReleaseRevision), snapshot: final.snapshot });
      lifetime.checkpoint();
      return { kind: "available", manifest: final.manifest, snapshot: final.snapshot,
        applicationReleaseRevision: final.applicationReleaseRevision, validUntil,
        manifestUrl: `/api/application-install/manifest?${query.toString()}` };
    });
  } catch (error) {
    return { kind: error instanceof InstallRefused ? "unavailable" : "temporarily_unavailable" };
  }
};
