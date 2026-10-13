import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  fingerprintSchema, organizationAccessDeclarationSchema, revisionSchema,
  type IdentitySession, type OrganizationAccessDeclaration, type SelectedOrganizationScope,
} from "@vortex/platform/schema";
import {
  assertBeforeLiveDeadline, LiveContextRefused, readLiveHumanContext, runOrganizationAccessOperation,
} from "@vortex/platform/server";
import {
  applicationInstallAddressSchema, createApplicationInstallManifest,
  createHumanInstalledRuntimeContextLoader,
  type ApplicationInstallAddress, type ApplicationInstallManifest, type InstalledRuntimeContext,
} from "@vortex/platform/server";
import type { RequestDatabaseTransaction } from "@vortex/platform/server";
import { withPooledRequestLifetime } from "@vortex/platform/server";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/platform/server";
import { createActiveApplicationInstallationRepository } from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { resolveApplicationAddress } from "./application-address";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { createApplicationInstallIcon } from "./application-install-icon";

const expectationSchema = z.object({ applicationReleaseRevision: revisionSchema,
  snapshot: fingerprintSchema }).strict();
type ApplicationInstallResult =
  | Readonly<{ kind: "unavailable" | "temporarily_unavailable" }>
  | Readonly<{ kind: "available"; manifest: ApplicationInstallManifest; manifestUrl: string;
      snapshot: string; applicationReleaseRevision: number; validUntil: string }>;
class InstallRefused extends Error {}
const refused = (): never => { throw new InstallRefused(); };
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

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

/** Current protected context of this request's session and application scope, before the deadline. */
const readHuman = async (transaction: RequestDatabaseTransaction, scope: SelectedOrganizationScope,
  session: IdentitySession, issuedAt: string, deadline: number) => {
  if (scope.applicationRootId === undefined) return refused();
  const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
  await assertBeforeLiveDeadline(transaction, deadline);
  return context;
};

const isRefusal = (error: unknown): boolean =>
  error instanceof InstallRefused || error instanceof LiveContextRefused;

/**
 * The request's own abort signal and deadline: checked between every step of the one read, and
 * applied to its database work, which is cancelled (releasing the pooled connection) on either.
 */
type InstallReadLifetime = Readonly<{ signal: AbortSignal; deadline: number; checkpoint: () => void }>;
class InstallReadEnded extends Error {}

const readCurrent = async (address: ApplicationInstallAddress, lifetime: InstallReadLifetime) => {
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
  // Identity and address reads are shared with the page of this render and keep their own
  // lifetime; the install read below is bounded by this request's signal and deadline.
  const result = await withPooledRequestLifetime(lifetime, () => humanOrganizationRequests().run(identity.session, {
    organizationId: resolved.read.organizationId, applicationRootId: resolved.application.applicationRootId,
  }, async (transaction, scope, issuedAt) => {
    try {
      lifetime.checkpoint();
      const human = await readHuman(transaction, scope, identity.session, issuedAt, lifetime.deadline);
      const installationReader = createActiveApplicationInstallationRepository(transaction);
      const releaseReader = createDatabaseApplicationBoundReleaseSetService(installedReleaseCatalogue, transaction);
      const load = () => createHumanInstalledRuntimeContextLoader({
        activeInstallationReader: installationReader,
        releaseSetReader: releaseReader,
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
      const installationFacts = JSON.stringify(initial.installation);
      const installationStillCurrent = async () =>
        JSON.stringify(await installationReader.readCurrent()) === installationFacts;
      const declaration = homeDeclaration(initial, resolved.application.homePageKey);
      const access = await runOrganizationAccessOperation(transaction, scope, declaration, async (decision) => {
        if (!await installationStillCurrent() ||
            initial.releaseSet.application.definitionKey !== address.applicationKey) return deny();
        let manifest: ApplicationInstallManifest;
        try { manifest = createApplicationInstallManifest(initial, address, createApplicationInstallIcon(initial)); }
        catch { return deny(); }
        // Re-evaluate the same current permission after icon/manifest derivation.
        const completion = await runOrganizationAccessOperation(transaction, scope,
          homeDeclaration(initial, resolved.application.homePageKey), async (finalDecision) => {
            if (!await installationStillCurrent()) return deny();
            const finalHuman = await readHuman(transaction, scope, identity.session, issuedAt, lifetime.deadline)
              .catch((error: unknown) => { if (isRefusal(error)) explicitRefusal = true; throw error; });
            if (JSON.stringify(finalHuman) !== JSON.stringify(human)) return deny();
            const expiry = Math.min(Date.parse(identity.session.accessTokenExpiresAt),
              Date.parse(decision.validUntil), Date.parse(finalDecision.validUntil), lifetime.deadline);
            if (!Number.isFinite(expiry)) return deny();
            await assertBeforeLiveDeadline(transaction, expiry);
            lifetime.checkpoint();
            return { manifest, snapshot: initialRelease, applicationReleaseRevision: initial.applicationReleaseRevision,
              validUntil: new Date(expiry).toISOString() };
          });
        if (completion.outcome !== "completed") return deny();
        return completion.value;
      });
      if (access.outcome !== "completed") return deny();
      return access.value;
    } catch (error) {
      if (isRefusal(error)) explicitRefusal = true;
      throw error;
    }
  }));
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
  // One read on the pooled request runner. Every access decision is still made inside it (and
  // re-evaluated after the manifest is derived); the request's signal and deadline end it early,
  // cancelling any statement still in flight so its pooled connection is released.
  const deadline = Date.now() + 15_000;
  const lifetime: InstallReadLifetime = { signal, deadline, checkpoint: () => {
    if (signal.aborted || Date.now() >= deadline) throw new InstallReadEnded();
  } };
  try {
    const current = await readCurrent(address.data, lifetime);
    if (current.kind !== "available") return current;
    if (expected?.success && (expected.data.snapshot !== current.snapshot ||
        expected.data.applicationReleaseRevision !== current.applicationReleaseRevision)) return { kind: "unavailable" };
    if (Date.now() >= Date.parse(current.validUntil)) return { kind: "unavailable" };
    const query = new URLSearchParams({ ...address.data,
      applicationReleaseRevision: String(current.applicationReleaseRevision), snapshot: current.snapshot });
    lifetime.checkpoint();
    return { kind: "available", manifest: current.manifest, snapshot: current.snapshot,
      applicationReleaseRevision: current.applicationReleaseRevision, validUntil: current.validUntil,
      manifestUrl: `/api/application-install/manifest?${query.toString()}` };
  } catch (error) {
    return { kind: isRefusal(error) ? "unavailable" : "temporarily_unavailable" };
  }
};
