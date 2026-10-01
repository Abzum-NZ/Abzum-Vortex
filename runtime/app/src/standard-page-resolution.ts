import "server-only";

import {
  inspectApplicationPageReplacements,
  pageIdSchema,
  sameId,
  type PageDefinitionV2,
} from "@vortex/contracts";
import { z } from "zod";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";

const selectionSchema = z.object({ pageId: pageIdSchema }).strict();

/** Only the requested endpoint is selectable; installed release evidence comes from App. */
export type InstalledPageIdentitySelection = Readonly<z.input<typeof selectionSchema>>;

export type InstalledPageEndpointIdentity = Readonly<{ pageId: string; key: string }>;

export type InstalledPageSubjectIdentity = Readonly<{
  moduleRootId: string;
  recordTypeId: string;
  moduleReleaseRevision: number;
  releaseVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

/** Detached server metadata, never permission authority or a replacement selection policy. */
export type InstalledPageIdentity = Readonly<{
  organizationId: string;
  applicationRootId: string;
  applicationReleaseRevision: number;
  releaseVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
  requested: InstalledPageEndpointIdentity;
  original: InstalledPageEndpointIdentity;
  replacement?: InstalledPageEndpointIdentity;
  pageType: PageDefinitionV2["type"];
  accessPermissionKey: string;
  subject?: InstalledPageSubjectIdentity;
}>;

const unavailable = (): never => {
  throw new Error("STANDARD_PAGE_RESOLUTION_UNAVAILABLE");
};

// Context provenance is attested separately. Refuse changed nested scope/binding evidence rather
// than treating it as a new installation or permitting a caller to select another release.
const verifyContext = (context: InstalledRuntimeContext): void => {
  const application = context.releaseSet.application;
  const installation = context.installation;
  const registration = context.permissionRegistration;
  const registeredRelease = registration.applicationRelease;
  if (
    !sameId(application.organizationId, context.organizationId) ||
    !sameId(application.rootId, context.applicationRootId) ||
    application.releaseRevision !== context.applicationReleaseRevision ||
    !sameId(application.correlationId, context.correlationId) ||
    !sameId(installation.organizationId, context.organizationId) ||
    !sameId(installation.applicationRootId, context.applicationRootId) ||
    installation.applicationReleaseRevision !== context.applicationReleaseRevision ||
    !sameId(registration.organizationId, context.organizationId) ||
    !sameId(registration.applicationRootId, context.applicationRootId) ||
    !sameId(registeredRelease.rootId, application.rootId) ||
    registeredRelease.releaseRevision !== application.releaseRevision ||
    registeredRelease.releaseVersion !== application.releaseVersion ||
    registeredRelease.contentFingerprint !== application.contentFingerprint ||
    registeredRelease.resolutionFingerprint !== application.resolutionFingerprint
  )
    unavailable();

  if (context.releaseSet.modules.length === 0) unavailable();
  const modules = new Map<string, number>();
  for (const module of context.releaseSet.modules) {
    const root = module.rootId.toLowerCase();
    if (
      modules.has(root) ||
      !sameId(module.organizationId, context.organizationId) ||
      !sameId(module.correlationId, context.correlationId)
    )
      unavailable();
    modules.set(root, module.releaseRevision);
  }
  const bindings = new Set<string>();
  for (const binding of installation.moduleBindings) {
    const root = binding.moduleRootId.toLowerCase();
    if (bindings.has(root) || modules.get(root) !== binding.moduleReleaseRevision) unavailable();
    bindings.add(root);
  }
  if (bindings.size !== modules.size) unavailable();
};

const subjectIdentity = (
  context: InstalledRuntimeContext,
  page: PageDefinitionV2,
): InstalledPageSubjectIdentity | undefined => {
  if (!("recordType" in page) || page.recordType === undefined) return undefined;
  const reference = page.recordType;
  if (reference.state !== "resolved") return unavailable();
  const modules = context.releaseSet.modules.filter((module) =>
    sameId(module.rootId, reference.moduleRootId),
  );
  const module = modules[0];
  if (modules.length !== 1 || module === undefined) return unavailable();
  const recordTypes = module.content.recordTypes.filter((recordType) =>
    sameId(recordType.recordTypeId, reference.recordTypeId),
  );
  const recordType = recordTypes[0];
  if (recordTypes.length !== 1 || recordType === undefined) return unavailable();
  return Object.freeze({
    moduleRootId: module.rootId,
    recordTypeId: recordType.recordTypeId,
    moduleReleaseRevision: module.releaseRevision,
    releaseVersion: module.releaseVersion,
    contentFingerprint: module.contentFingerprint,
    resolutionFingerprint: module.resolutionFingerprint,
  });
};

const endpointIdentity = (page: PageDefinitionV2): InstalledPageEndpointIdentity =>
  Object.freeze({ pageId: page.pageId, key: page.key });

/**
 * Resolve either endpoint of a declared retained pair in this exact installed Application.
 * Unknown IDs are absent; corrupt evidence is opaque failure. The requested endpoint is never
 * replaced by its sibling. Access and installation decisions remain with their existing services.
 */
export const resolveInstalledPageIdentity = (
  candidate: InstalledRuntimeContext,
  selection: InstalledPageIdentitySelection,
): InstalledPageIdentity | undefined => {
  try {
    const context = requireInstalledRuntimeContext(candidate);
    const parsedSelection = selectionSchema.safeParse(selection);
    if (!parsedSelection.success) return unavailable();
    verifyContext(context);
    const application = context.releaseSet.application;
    const pages = application.content.pages;
    if (
      pages.some((page) => !pageIdSchema.safeParse(page.pageId).success) ||
      inspectApplicationPageReplacements(
        pages.map((page) => ({
          identities: [page.pageId],
          type: page.type,
          permission: page.accessPermissionKey,
          replaces: page.replacementOfPageId,
          subject:
            "recordType" in page && page.recordType !== undefined
              ? page.recordType.state === "resolved"
                ? ([page.recordType.moduleRootId, page.recordType.recordTypeId] as const)
                : null
              : undefined,
        })),
      ).length !== 0
    )
      return unavailable();

    const requested = pages.find((page) => sameId(page.pageId, parsedSelection.data.pageId));
    if (requested === undefined) return undefined;
    const originalPageId = requested.replacementOfPageId;
    const original =
      originalPageId === undefined
        ? requested
        : pages.find((page) => sameId(page.pageId, originalPageId));
    if (original === undefined) return unavailable();
    const replacement = pages.find(
      (page) =>
        page.replacementOfPageId !== undefined &&
        sameId(page.replacementOfPageId, original.pageId),
    );
    const subject = subjectIdentity(context, original);
    // Resolve each declared endpoint's subject against real bound records, including unpaired
    // pages. The shared inspector has already proved matching resolved subject identities.
    if (replacement !== undefined) subjectIdentity(context, replacement);
    return Object.freeze({
      organizationId: application.organizationId,
      applicationRootId: application.rootId,
      applicationReleaseRevision: application.releaseRevision,
      releaseVersion: application.releaseVersion,
      contentFingerprint: application.contentFingerprint,
      resolutionFingerprint: application.resolutionFingerprint,
      requested: endpointIdentity(requested),
      original: endpointIdentity(original),
      ...(replacement === undefined ? {} : { replacement: endpointIdentity(replacement) }),
      pageType: original.type,
      accessPermissionKey: original.accessPermissionKey,
      ...(subject === undefined ? {} : { subject }),
    });
  } catch {
    // Never surface a parser issue, raw endpoint, release contents or nested evidence to callers.
    return unavailable();
  }
};
