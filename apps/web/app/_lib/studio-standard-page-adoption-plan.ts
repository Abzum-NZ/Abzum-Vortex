import "server-only";

import {
  applicationRootIdSchema,
  canonicalJson,
  fingerprintCanonicalValue,
  pageIdSchema,
  platformIdSchema,
  sameId,
  type ApplicationContentV2,
  type ApplicationSourceDocumentV2,
  type PageDefinitionV2,
  type SourceIdentityAssignmentV3,
} from "@vortex/contracts";
import type { StoredApplicationDefinitionDraft } from "@vortex/definition";
import type { AuthenticatedApplicationPageAdoptionRelease } from "@vortex/definition";
import { z } from "zod";

export const pageAdoptionCommandSchema = z
  .object({
    rootId: applicationRootIdSchema,
    expectedDraftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    expectedPublicationAnchor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    candidateReleaseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    originalPageId: pageIdSchema,
    replacementPageId: pageIdSchema,
    comparisonFingerprint: z.string().min(1).max(240),
    decision: z.enum(["keep_replacement", "adopt_original"]),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("navigation"), id: platformIdSchema }).strict(),
      z.object({ kind: z.literal("role_home"), id: platformIdSchema }).strict(),
      z.object({ kind: z.literal("application_home"), id: applicationRootIdSchema }).strict(),
    ]),
  })
  .strict();

export type PageAdoptionCommand = z.infer<typeof pageAdoptionCommandSchema>;
export type PageAdoptionTarget = PageAdoptionCommand["target"];

export type PageAdoptionTargetOption = Readonly<{
  target: PageAdoptionTarget;
  label: string;
}>;

export type PageAdoptionPlan = Readonly<{
  source: ApplicationSourceDocumentV2;
  expectedCanonicalContent: ApplicationContentV2;
  comparisonFingerprint: string;
  original: Readonly<{ pageId: string; key: string; name: string; type: PageDefinitionV2["type"] }>;
  replacement: Readonly<{ pageId: string; key: string; name: string; type: PageDefinitionV2["type"] }>;
  candidate: Readonly<{ releaseRevision: number; releaseVersion: string; impactReasons: readonly Readonly<{ code: string; impact: string }>[] }>;
  target: PageAdoptionTargetOption;
  decision: PageAdoptionCommand["decision"];
}>;

const invalid = (): never => {
  throw new Error("STUDIO_PAGE_ADOPTION_UNAVAILABLE");
};

const sourcePageIdentifier = (
  source: ApplicationSourceDocumentV2,
  identities: readonly SourceIdentityAssignmentV3[],
  page: ApplicationSourceDocumentV2["body"]["pages"][number],
): PageDefinitionV2["pageId"] => {
  const matches = identities.filter(
    (identity) =>
      identity.definitionKey === source.key &&
      identity.scope === "content" &&
      identity.kind === "page" &&
      identity.componentOwner === page.id &&
      identity.alias === page.id,
  );
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || !pageIdSchema.safeParse(match.identifier).success) return invalid();
  return pageIdSchema.parse(match.identifier);
};

const sourcePagesByIdentifier = (
  source: ApplicationSourceDocumentV2,
  identities: readonly SourceIdentityAssignmentV3[],
): ReadonlyMap<string, ApplicationSourceDocumentV2["body"]["pages"][number]> => {
  const pages = new Map<string, ApplicationSourceDocumentV2["body"]["pages"][number]>();
  for (const page of source.body.pages) {
    const identifier = sourcePageIdentifier(source, identities, page).toLowerCase();
    if (pages.has(identifier)) return invalid();
    pages.set(identifier, page);
  }
  return pages;
};

const canonicalPage = (
  content: ApplicationContentV2,
  pageId: string,
): PageDefinitionV2 => {
  const matches = content.pages.filter((page) => sameId(page.pageId, pageId));
  if (matches.length !== 1 || matches[0] === undefined) return invalid();
  return matches[0];
};

const identityForComponent = (
  source: ApplicationSourceDocumentV2,
  identities: readonly SourceIdentityAssignmentV3[],
  kind: "navigation_item" | "role",
  componentOwner: string,
): SourceIdentityAssignmentV3["identifier"] => {
  const matches = identities.filter(
    (identity) =>
      identity.definitionKey === source.key &&
      identity.scope === "content" &&
      identity.kind === kind &&
      identity.componentOwner === componentOwner &&
      identity.alias === componentOwner,
  );
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || !platformIdSchema.safeParse(match.identifier).success) return invalid();
  return match.identifier;
};

type SourceNavigationItem = ApplicationSourceDocumentV2["body"]["navigation"][number];
const flattenNavigation = (items: readonly SourceNavigationItem[]): SourceNavigationItem[] =>
  items.flatMap((item) => [item, ...(item.type === "heading" ? flattenNavigation(item.children) : [])]);

const targetOptions = (
  draft: StoredApplicationDefinitionDraft,
  identities: readonly SourceIdentityAssignmentV3[],
  currentContent: ApplicationContentV2,
  release: AuthenticatedApplicationPageAdoptionRelease,
  originalPageId: string,
  replacementPageId: string,
): PageAdoptionTargetOption[] => {
  const source = draft.source;
  const currentPages = sourcePagesByIdentifier(source, identities);
  const original = currentPages.get(originalPageId.toLowerCase());
  const replacement = currentPages.get(replacementPageId.toLowerCase());
  const candidatePages = sourcePagesByIdentifier(release.authoredSource, release.identities);
  const candidateOriginal = candidatePages.get(originalPageId.toLowerCase());
  if (original === undefined || replacement === undefined || candidateOriginal === undefined) return invalid();
  const canonicalOriginal = canonicalPage(
    release.compilationOutput.canonical.content,
    originalPageId,
  );
  const canonicalReplacement = canonicalPage(currentContent, replacementPageId);
  if (
    canonicalOriginal.type === "public" ||
    canonicalReplacement.type === "public" ||
    canonicalOriginal.type !== canonicalReplacement.type ||
    canonicalOriginal.accessPermissionKey !== canonicalReplacement.accessPermissionKey ||
    canonicalJson("recordType" in canonicalOriginal ? canonicalOriginal.recordType ?? null : null) !==
      canonicalJson("recordType" in canonicalReplacement ? canonicalReplacement.recordType ?? null : null)
  )
    return invalid();

  const options: PageAdoptionTargetOption[] = [];
  for (const item of flattenNavigation(source.body.navigation)) {
    if (item.type !== "page" || item.page !== replacement.key) continue;
    const id = identityForComponent(source, identities, "navigation_item", item.id);
    options.push({ target: { kind: "navigation", id }, label: `Navigation: ${item.label}` });
  }
  for (const role of source.body.roles) {
    if (role.home_page !== replacement.key) continue;
    const id = identityForComponent(source, identities, "role", role.id);
    options.push({ target: { kind: "role_home", id }, label: `Role home: ${role.name}` });
  }
  if (source.body.home_page === replacement.key) {
    options.push({
      target: { kind: "application_home", id: applicationRootIdSchema.parse(draft.rootId) },
      label: "Application home",
    });
  }
  if (options.length === 0) return invalid();
  return options;
};

const setNavigationPage = (
  items: readonly SourceNavigationItem[],
  identity: string,
  pageKey: string,
  identities: readonly SourceIdentityAssignmentV3[],
  source: ApplicationSourceDocumentV2,
): readonly SourceNavigationItem[] =>
  items.map((item) => {
    if (item.type === "heading")
      return { ...item, children: setNavigationPage(item.children, identity, pageKey, identities, source) };
    if (item.type !== "page") return item;
    const itemIdentity = identityForComponent(source, identities, "navigation_item", item.id);
    return sameId(itemIdentity, identity) ? { ...item, page: pageKey } : item;
  });

const replaceSelectedTarget = (
  source: ApplicationSourceDocumentV2,
  identities: readonly SourceIdentityAssignmentV3[],
  rootId: string,
  target: PageAdoptionTarget,
  replacementKey: string,
  originalKey: string,
): ApplicationSourceDocumentV2 => {
  if (target.kind === "application_home") {
    if (!sameId(target.id, rootId) || source.body.home_page !== replacementKey) return invalid();
    return { ...source, body: { ...source.body, home_page: originalKey } };
  }
  if (target.kind === "navigation") {
    const matches = flattenNavigation(source.body.navigation).filter(
      (item) =>
        item.type === "page" &&
        sameId(identityForComponent(source, identities, "navigation_item", item.id), target.id) &&
        item.page === replacementKey,
    );
    if (matches.length !== 1) return invalid();
    return {
      ...source,
      body: {
        ...source.body,
        navigation: setNavigationPage(
          source.body.navigation,
          target.id,
          originalKey,
          identities,
          source,
        ),
      },
    };
  }
  const matches = source.body.roles.filter(
    (role) =>
      sameId(identityForComponent(source, identities, "role", role.id), target.id) &&
      role.home_page === replacementKey,
  );
  if (matches.length !== 1) return invalid();
  return {
    ...source,
    body: {
      ...source.body,
      roles: source.body.roles.map((role) =>
        sameId(identityForComponent(source, identities, "role", role.id), target.id)
          ? { ...role, home_page: originalKey }
          : role,
      ),
    },
  };
};

const canonicalTargetIsPage = (
  content: ApplicationContentV2,
  rootId: string,
  target: PageAdoptionTarget,
  pageId: string,
): boolean => {
  if (target.kind === "application_home")
    return sameId(target.id, rootId) && sameId(content.homePageId, pageId);
  if (target.kind === "role_home") {
    const matches = content.roles.filter((role) => sameId(role.roleId, target.id));
    const match = matches[0];
    return matches.length === 1 && match !== undefined && sameId(match.homePageId, pageId);
  }
  const visit = (items: readonly ApplicationContentV2["navigation"][number][]): string[] =>
    items.flatMap((item) =>
      item.type === "heading"
        ? visit(item.children)
        : item.type === "page" && sameId(item.id, target.id)
          ? [String(item.pageId)]
          : [],
    );
  const matches = visit(content.navigation);
  const match = matches[0];
  return matches.length === 1 && match !== undefined && sameId(match, pageId);
};

const normalizedSource = (
  source: ApplicationSourceDocumentV2,
  identities: readonly SourceIdentityAssignmentV3[],
  omittedPageIds: readonly string[],
  target: PageAdoptionTarget,
): unknown => {
  const omitted = new Set(omittedPageIds.map((id) => id.toLowerCase()));
  const pages = source.body.pages.filter(
    (page) => !omitted.has(sourcePageIdentifier(source, identities, page).toLowerCase()),
  );
  const marker = "__page_adoption_target__";
  let body = { ...source.body, pages };
  if (target.kind === "application_home") body = { ...body, home_page: marker };
  if (target.kind === "role_home")
    body = {
      ...body,
      roles: body.roles.map((role) =>
        sameId(identityForComponent(source, identities, "role", role.id), target.id)
          ? { ...role, home_page: marker }
          : role,
      ),
    };
  if (target.kind === "navigation") {
    const normalize = (items: readonly SourceNavigationItem[]): readonly SourceNavigationItem[] =>
      items.map((item) => {
        if (item.type === "heading") return { ...item, children: normalize(item.children) };
        if (item.type !== "page") return item;
        return sameId(identityForComponent(source, identities, "navigation_item", item.id), target.id)
          ? { ...item, page: marker }
          : item;
      });
    body = { ...body, navigation: normalize(body.navigation) };
  }
  return { ...source, body };
};

const normalizedCanonical = (
  content: ApplicationContentV2,
  omittedPageIds: readonly string[],
  target: PageAdoptionTarget,
): unknown => {
  const omitted = new Set(omittedPageIds.map((id) => id.toLowerCase()));
  const marker = pageIdSchema.parse(omittedPageIds[0]);
  const pages = content.pages.filter((page) => !omitted.has(String(page.pageId).toLowerCase()));
  let normalized: ApplicationContentV2 = { ...content, pages };
  if (target.kind === "application_home") normalized = { ...normalized, homePageId: marker };
  if (target.kind === "role_home")
    normalized = {
      ...normalized,
      roles: normalized.roles.map((role) =>
        sameId(role.roleId, target.id)
          ? { ...role, homePageId: marker }
          : role,
      ),
    };
  if (target.kind === "navigation") {
    const normalize = (items: readonly ApplicationContentV2["navigation"][number][]): ApplicationContentV2["navigation"] =>
      items.map((item) =>
        item.type === "heading"
          ? { ...item, children: normalize(item.children) }
            : item.type === "page" && sameId(item.id, target.id)
              ? { ...item, pageId: marker }
            : item,
      );
    normalized = { ...normalized, navigation: normalize(normalized.navigation) };
  }
  return normalized;
};

export const buildPageAdoptionPlan = (input: Readonly<{
  draft: StoredApplicationDefinitionDraft;
  currentIdentities: readonly SourceIdentityAssignmentV3[];
  currentContent: ApplicationContentV2;
  release: AuthenticatedApplicationPageAdoptionRelease;
  originalPageId: string;
  replacementPageId: string;
  target: PageAdoptionTarget;
  decision: PageAdoptionCommand["decision"];
}>): PageAdoptionPlan => {
  const { draft, currentIdentities, currentContent, release, originalPageId, replacementPageId, target, decision } = input;
  if (
    draft.source.kind !== "application" ||
    draft.publishedRevision === undefined ||
    release.rootId !== String(draft.rootId) ||
    !sameId(release.organizationId, draft.organizationId) ||
    release.publication.revision !== draft.publishedRevision ||
    release.compilationOutput.canonical.envelope.rootId !== draft.rootId ||
    !sameId(release.compilationOutput.canonical.envelope.organizationId, draft.organizationId) ||
    release.authoredSourceFingerprint !== fingerprintCanonicalValue(release.authoredSource)
  )
    return invalid();

  const currentPages = sourcePagesByIdentifier(draft.source, currentIdentities);
  const candidatePages = sourcePagesByIdentifier(release.authoredSource, release.identities);
  const original = currentPages.get(originalPageId.toLowerCase());
  const replacement = currentPages.get(replacementPageId.toLowerCase());
  const candidateOriginal = candidatePages.get(originalPageId.toLowerCase());
  if (
    original === undefined || replacement === undefined || candidateOriginal === undefined ||
    sameId(originalPageId, replacementPageId) ||
    original.replaces_page !== undefined ||
    replacement.replaces_page === undefined ||
    candidateOriginal.replaces_page !== undefined ||
    !sameId(sourcePageIdentifier(draft.source, currentIdentities, original), originalPageId) ||
    !sameId(sourcePageIdentifier(draft.source, currentIdentities, replacement), replacementPageId) ||
    !sameId(sourcePageIdentifier(release.authoredSource, release.identities, candidateOriginal), originalPageId) ||
    original.key !== candidateOriginal.key ||
    !sameId(replacement.replaces_page, original.id)
  )
    return invalid();

  const currentOriginalCanonical = canonicalPage(currentContent, originalPageId);
  const currentReplacementCanonical = canonicalPage(currentContent, replacementPageId);
  const candidateOriginalCanonical = canonicalPage(release.compilationOutput.canonical.content, originalPageId);
  if (
    currentOriginalCanonical.type === "public" ||
    currentReplacementCanonical.type === "public" ||
    candidateOriginalCanonical.type === "public" ||
    currentOriginalCanonical.type !== currentReplacementCanonical.type ||
    candidateOriginalCanonical.type !== currentOriginalCanonical.type ||
    currentOriginalCanonical.accessPermissionKey !== currentReplacementCanonical.accessPermissionKey ||
    candidateOriginalCanonical.accessPermissionKey !== currentOriginalCanonical.accessPermissionKey ||
    canonicalJson("recordType" in currentOriginalCanonical ? currentOriginalCanonical.recordType ?? null : null) !==
      canonicalJson("recordType" in currentReplacementCanonical ? currentReplacementCanonical.recordType ?? null : null) ||
    canonicalJson("recordType" in candidateOriginalCanonical ? candidateOriginalCanonical.recordType ?? null : null) !==
      canonicalJson("recordType" in currentOriginalCanonical ? currentOriginalCanonical.recordType ?? null : null)
  )
    return invalid();

  const options = targetOptions(
    draft,
    currentIdentities,
    currentContent,
    release,
    originalPageId,
    replacementPageId,
  );
  const targetOption = options.find((option) => canonicalJson(option.target) === canonicalJson(target));
  if (targetOption === undefined) return invalid();
  if (
    !canonicalTargetIsPage(currentContent, String(draft.rootId), target, replacementPageId) ||
    !canonicalTargetIsPage(release.compilationOutput.canonical.content, String(draft.rootId), target, originalPageId)
  )
    return invalid();

  const normalizedCurrentSource = normalizedSource(draft.source, currentIdentities, [originalPageId, replacementPageId], target);
  const normalizedCandidateSource = normalizedSource(release.authoredSource, release.identities, [originalPageId], target);
  const normalizedCurrentContent = normalizedCanonical(currentContent, [originalPageId, replacementPageId], target);
  const normalizedCandidateContent = normalizedCanonical(release.compilationOutput.canonical.content, [originalPageId], target);
  if (
    canonicalJson(normalizedCurrentSource) !== canonicalJson(normalizedCandidateSource) ||
    canonicalJson(normalizedCurrentContent) !== canonicalJson(normalizedCandidateContent)
  )
    return invalid();

  const replacementPage = currentPages.get(replacementPageId.toLowerCase());
  if (replacementPage === undefined) return invalid();
  let source: ApplicationSourceDocumentV2 = {
    ...draft.source,
    body: {
      ...draft.source.body,
      pages: draft.source.body.pages.map((page) =>
        sameId(sourcePageIdentifier(draft.source, currentIdentities, page), originalPageId)
          ? { ...candidateOriginal, id: original.id }
          : page,
      ),
    },
  };
  if (decision === "adopt_original")
    source = replaceSelectedTarget(
      source,
      currentIdentities,
      String(draft.rootId),
      target,
      replacementPage.key,
      candidateOriginal.key,
    );

  const expectedCanonicalContent: ApplicationContentV2 = {
    ...currentContent,
    pages: currentContent.pages.map((page) =>
      sameId(page.pageId, originalPageId) ? candidateOriginalCanonical : page,
    ),
    ...(decision === "adopt_original"
      ? target.kind === "application_home"
        ? { homePageId: candidateOriginalCanonical.pageId }
        : target.kind === "role_home"
          ? {
              roles: currentContent.roles.map((role) =>
                sameId(role.roleId, target.id)
                  ? { ...role, homePageId: candidateOriginalCanonical.pageId }
                  : role,
              ),
            }
          : {
              navigation: (() => {
                const replace = (items: readonly ApplicationContentV2["navigation"][number][]): ApplicationContentV2["navigation"] =>
                  items.map((item) =>
                    item.type === "heading"
                      ? { ...item, children: replace(item.children) }
                      : item.type === "page" && sameId(item.id, target.id)
                        ? { ...item, pageId: candidateOriginalCanonical.pageId }
                        : item,
                  );
                return replace(currentContent.navigation);
              })(),
            }
      : {}),
  };
  // The saved authored document is compiled again after the write; this server-side expected
  // canonical value proves no other current Application binding changed.
  const comparisonFingerprint = fingerprintCanonicalValue({
    organizationId: draft.organizationId,
    rootId: draft.rootId,
    draftRevision: draft.draftRevision,
    sourceFingerprint: draft.sourceFingerprint,
    expectedPublicationAnchor: draft.publishedRevision,
    candidateReleaseRevision: release.publication.revision,
    candidateContentFingerprint: release.publication.contentFingerprint,
    candidateResolutionFingerprint: release.compilationOutput.resolutionFingerprint,
    candidateComparisonFingerprint: release.comparisonFingerprint,
    originalPageId,
    replacementPageId,
    target,
    decision,
  });
  return Object.freeze({
    source,
    expectedCanonicalContent,
    comparisonFingerprint,
    original: {
      pageId: originalPageId,
      key: original.key,
      name: original.name,
      type: currentOriginalCanonical.type,
    },
    replacement: {
      pageId: replacementPageId,
      key: replacement.key,
      name: replacement.name,
      type: currentReplacementCanonical.type,
    },
    candidate: {
      releaseRevision: release.publication.revision,
      releaseVersion: release.publication.releaseVersion,
      impactReasons: release.impactReasons.map((reason) => ({ code: reason.code, impact: reason.impact })),
    },
    target: targetOption,
    decision,
  });
};

export const listPageAdoptionTargets = (
  draft: StoredApplicationDefinitionDraft,
  identities: readonly SourceIdentityAssignmentV3[],
  currentContent: ApplicationContentV2,
  release: AuthenticatedApplicationPageAdoptionRelease,
  originalPageId: string,
  replacementPageId: string,
): readonly PageAdoptionTargetOption[] => targetOptions(
  draft,
  identities,
  currentContent,
  release,
  originalPageId,
  replacementPageId,
);
