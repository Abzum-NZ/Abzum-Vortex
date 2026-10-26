import "server-only";

import type { PreparedApplicationPermissionRegistration } from "../access/permission-registry";
import { jsonValueSchema } from "../catalogue/common";
import type { ResolvedPageComposition } from "../pages/page-composition-resolution";
import { canonicalJson } from "./canonical-json";
import {
  systemApplicationBoundReleaseSetResultSchema,
  type SystemApplicationBoundReleaseSetResult,
} from "./definition-consumer-read";
import {
  installationRuntimeBundlePagesSectionSchema,
  type installationRuntimeBundleSections,
  type InstallationRuntimeBundleSourceManifest,
} from "./installation-runtime-bundle";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import {
  createActiveInstallationBundleRepository,
  activeInstallationBundleStateSchema,
  type ActiveInstallationBundleState,
} from "./active-installation-bundle-repository";
import { z } from "zod";
import {
  assembleHumanInstalledRuntimeContext,
  readHumanActiveInstallation,
  requireInstalledRuntimeContext,
  type HumanInstalledRuntimeContextDependencies,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";
import { readInstalledRecordContributions } from "./installed-record-contributions";

type InstalledPageBundleIdentityEvidence = Readonly<{
  organizationId: ActiveInstallationBundleState["identity"]["organizationId"];
  applicationRootId: ActiveInstallationBundleState["identity"]["applicationRootId"];
  applicationReleaseRevision: ActiveInstallationBundleState["identity"]["applicationReleaseRevision"];
  pinFingerprint: ActiveInstallationBundleState["identity"]["pinFingerprint"];
  moduleBindings: ActiveInstallationBundleState["identity"]["moduleBindings"];
  pinFacts: ActiveInstallationBundleState["identity"]["pinFacts"];
  sourceManifest: InstallationRuntimeBundleSourceManifest;
}>;

/** The validated, deep-frozen release set and page compositions of one immutable installed release. */
type InstalledPageBundle = Readonly<{
  releaseSet: SystemApplicationBoundReleaseSetResult;
  compositions: ReadonlyMap<string, ResolvedPageComposition>;
}>;

/** Retained size of the cache, counted as the stored section text each parsed bundle came from. */
const installedPageBundleCacheBudget = 256 * 1024 * 1024;
const installedPageBundles = new Map<
  string,
  Readonly<{ bundle: InstalledPageBundle; size: number }>
>();
let installedPageBundlesSize = 0;

const retainInstalledPageBundle = (
  key: string,
  bundle: InstalledPageBundle,
  size: number,
): void => {
  const previous = installedPageBundles.get(key);
  if (previous !== undefined) {
    installedPageBundles.delete(key);
    installedPageBundlesSize -= previous.size;
  }
  if (size > installedPageBundleCacheBudget) return;
  for (const [oldest, entry] of installedPageBundles) {
    if (installedPageBundlesSize + size <= installedPageBundleCacheBudget) break;
    installedPageBundles.delete(oldest);
    installedPageBundlesSize -= entry.size;
  }
  installedPageBundles.set(key, { bundle, size });
  installedPageBundlesSize += size;
};

const installedPageBundleKey = (identity: ActiveInstallationBundleState["identity"]): string =>
  JSON.stringify([
    identity.organizationId.toLowerCase(),
    identity.applicationRootId.toLowerCase(),
    identity.applicationReleaseRevision,
    identity.pinFingerprint,
    identity.registeredApplication.contentFingerprint,
    identity.registeredApplication.resolutionFingerprint,
  ]);

const requireSection = (
  sections: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
  section: (typeof installationRuntimeBundleSections)[number],
): unknown => {
  const parsed = jsonValueSchema.safeParse(sections[section]);
  if (!parsed.success) throw new Error("INSTALLED_PAGE_BUNDLE_SECTION_UNAVAILABLE");
  return parsed.data;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  Object.freeze(value);
  return value;
};

const bundleFromSections = (
  sections: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
  correlationId: ActiveInstallationBundleState["identity"]["correlationId"],
): InstalledPageBundle => {
  const pages = installationRuntimeBundlePagesSectionSchema.parse(
    requireSection(sections, "pages"),
  );
  const flows = z
    .object({ flows: z.array(z.unknown()), flowBindings: z.array(z.unknown()) })
    .strict()
    .parse(requireSection(sections, "flows"));
  const applicationContent = {
    ...pages.application.content,
    pages: pages.application.pages,
    shells: pages.application.shells,
    navigation: requireSection(sections, "navigation"),
    flows: flows.flows,
    flowBindings: flows.flowBindings,
    theme: requireSection(sections, "theme"),
    platformBlockDependencies: requireSection(sections, "component_registry"),
  };
  const releaseSet = deepFreeze(
    systemApplicationBoundReleaseSetResultSchema.parse({
      application: {
        ...pages.application.identity,
        correlationId,
        content: applicationContent,
        toolBundle: requireSection(sections, "tool_bundle"),
      },
      modules: pages.modules.map((module) => ({
        ...module.identity,
        correlationId,
        content: module.content,
      })),
    }),
  );
  const application = releaseSet.application;
  if (pages.resolvedCompositions.length !== application.content.pages.length)
    throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
  const compositions = new Map<string, ResolvedPageComposition>();
  for (const [index, composition] of pages.resolvedCompositions.entries()) {
    const page = application.content.pages[index];
    if (page === undefined || page.pageId !== composition.pageId)
      throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
    const key = composition.pageId.toLowerCase();
    if (compositions.has(key)) throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
    compositions.set(key, deepFreeze({ page, roots: composition.roots }));
  }
  return Object.freeze({ releaseSet, compositions });
};

/** The release is immutable, but each request names its own correlation, so only the shallow records are re-stamped. */
const withCorrelation = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  correlationId: ActiveInstallationBundleState["identity"]["correlationId"],
): SystemApplicationBoundReleaseSetResult => ({
  application: Object.freeze({ ...releaseSet.application, correlationId }),
  modules: releaseSet.modules.map((module) => Object.freeze({ ...module, correlationId })),
});

/**
 * The permission registration of one immutable installed bundle, prepared once per organisation,
 * application and release revision and then shared. Preparation is a pure function of
 * those and the bundle's frozen release content, so a cached registration is exactly the one this
 * request would prepare; it decides nothing, and every request still checks its installation
 * against the release set before the registration is used. It lives as long as its bundle.
 */
const preparedRegistrations = new WeakMap<
  InstalledPageBundle,
  Map<string, PreparedApplicationPermissionRegistration>
>();

const preparedRegistrationFor = (
  bundle: InstalledPageBundle,
  validated: SystemApplicationBoundReleaseSetResult,
  prepare: (
    validated: SystemApplicationBoundReleaseSetResult,
  ) => PreparedApplicationPermissionRegistration,
): PreparedApplicationPermissionRegistration => {
  const application = validated.application;
  // Each request stamps its own correlation on the shared release; the registration does not carry
  // it, but preparation requires one correlation across the set, so a mixed set is prepared (and
  // refused) afresh rather than answered from the cache.
  if (validated.modules.some((module) => module.correlationId !== application.correlationId))
    return prepare(validated);
  const key = JSON.stringify([
    application.organizationId.toLowerCase(),
    application.rootId.toLowerCase(),
    application.releaseRevision,
  ]);
  let registrations = preparedRegistrations.get(bundle);
  if (registrations === undefined) {
    registrations = new Map();
    preparedRegistrations.set(bundle, registrations);
  }
  const cached = registrations.get(key);
  if (cached !== undefined) return cached;
  const prepared = deepFreeze(prepare(validated));
  registrations.set(key, prepared);
  return prepared;
};

const identityMatchesReleaseSet = (
  state: ActiveInstallationBundleState,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): void => {
  const { identity } = state;
  const application = releaseSet.application;
  if (
    application.organizationId !== identity.organizationId ||
    application.rootId !== identity.applicationRootId ||
    application.releaseRevision !== identity.applicationReleaseRevision ||
    application.correlationId !== identity.correlationId ||
    application.definitionKey !== identity.registeredApplication.definitionKey ||
    application.releaseVersion !== identity.registeredApplication.releaseVersion ||
    application.validationContractVersion !==
      identity.registeredApplication.validationContractVersion ||
    application.contentFingerprint !== identity.registeredApplication.contentFingerprint ||
    application.resolutionFingerprint !== identity.registeredApplication.resolutionFingerprint
  )
    throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  const modules = [...releaseSet.modules].sort((left, right) =>
    left.rootId.toLowerCase() < right.rootId.toLowerCase()
      ? -1
      : left.rootId.toLowerCase() > right.rootId.toLowerCase()
        ? 1
        : 0,
  );
  if (modules.length !== identity.moduleBindings.length)
    throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  for (const [index, module] of modules.entries()) {
    const binding = identity.moduleBindings[index];
    const pin = identity.pinFacts[index];
    if (
      binding === undefined ||
      pin === undefined ||
      module.organizationId !== identity.organizationId ||
      module.correlationId !== identity.correlationId ||
      module.rootId !== binding.moduleRootId ||
      module.releaseRevision !== binding.moduleReleaseRevision ||
      module.rootId !== pin.moduleRootId ||
      module.releaseRevision !== pin.moduleReleaseRevision ||
      module.contentFingerprint !== pin.contentFingerprint ||
      module.resolutionFingerprint !== pin.resolutionFingerprint
    )
      throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  }
};

type HumanInstalledPageBundleContextDependencies = Readonly<{
  transaction: RequestDatabaseTransaction;
  scope: HumanInstalledRuntimeContextDependencies["scope"];
}>;

/**
 * Builds the genuine current HUMAN Page context from the cached installed release. Only the active
 * installation identity is read per request; the bundle is read and validated once per immutable
 * release. A missing bundle is an install or activation defect and fails here instead of being repaired.
 */
export const createHumanInstalledPageBundleContextLoader = (
  dependencies: HumanInstalledPageBundleContextDependencies,
) => {
  const repository = createActiveInstallationBundleRepository(dependencies.transaction);
  return Object.freeze({
    async load(): Promise<InstalledRuntimeContext> {
      // A preview request runs the preview's stored release set, never the live bundle.
      if (dependencies.scope.previewInstallationId !== undefined) {
        const { loadHumanPreviewRuntimeContext } = await import("./preview-runtime-context");
        return loadHumanPreviewRuntimeContext(dependencies.transaction, dependencies.scope);
      }
      const installation = await readHumanActiveInstallation({
        activeInstallationReader: repository,
        scope: dependencies.scope,
      });
      const state = await repository.readCurrentState();
      const bundleIndex = state.bundleIndex;
      if (bundleIndex === null) throw new Error("INSTALLED_PAGE_BUNDLE_INDEX_UNAVAILABLE");
      const key = installedPageBundleKey(state.identity);
      const cached = installedPageBundles.get(key);
      let bundle: InstalledPageBundle;
      if (cached === undefined) {
        const { sections, textLength } = await repository.readSections(state);
        bundle = bundleFromSections(sections, state.identity.correlationId);
        identityMatchesReleaseSet(state, bundle.releaseSet);
        retainInstalledPageBundle(key, bundle, textLength);
      } else {
        bundle = cached.bundle;
        retainInstalledPageBundle(key, bundle, cached.size);
      }
      // The installed bundle is immutable, but what other installed Modules contribute to its
      // record types changes with their installations, so it is read with every request.
      const contributions = await readInstalledRecordContributions(dependencies.transaction);
      const context = assembleHumanInstalledRuntimeContext(
        installation,
        withCorrelation(bundle.releaseSet, state.identity.correlationId),
        dependencies.scope,
        (validated, prepare) => preparedRegistrationFor(bundle, validated, prepare),
        contributions,
      );
      return retainPageCompositions(
        context,
        bundle.compositions,
        deepFreeze({
          organizationId: state.identity.organizationId,
          applicationRootId: state.identity.applicationRootId,
          applicationReleaseRevision: state.identity.applicationReleaseRevision,
          pinFingerprint: state.identity.pinFingerprint,
          moduleBindings: state.identity.moduleBindings,
          pinFacts: state.identity.pinFacts,
          sourceManifest: bundleIndex.sourceManifest,
        }),
      );
    },
  });
};

const installedPageCompositions = new WeakMap<
  object,
  ReadonlyMap<string, ResolvedPageComposition>
>();
const installedPageBundleIdentities = new WeakMap<object, InstalledPageBundleIdentityEvidence>();

const retainPageCompositions = <Context extends InstalledRuntimeContext>(
  context: Context,
  compositions: ReadonlyMap<string, ResolvedPageComposition>,
  identity: InstalledPageBundleIdentityEvidence,
): Context => {
  installedPageCompositions.set(context, compositions);
  installedPageBundleIdentities.set(context, identity);
  return context;
};

/** True only for an App context this module assembled from the active installed-bundle reader. */
export const isTrustedInstalledPageBundleContext = (
  contextCandidate: unknown,
): contextCandidate is InstalledRuntimeContext => {
  try {
    const context = requireInstalledRuntimeContext(contextCandidate);
    return installedPageBundleIdentities.has(context);
  } catch {
    return false;
  }
};

/** Returns only the canonical precomposition held by this request's assembled App context. */
export const readInstalledPageComposition = (
  contextCandidate: unknown,
  pageId: string,
): ResolvedPageComposition | undefined => {
  try {
    const context = requireInstalledRuntimeContext(contextCandidate);
    return installedPageCompositions.get(context)?.get(pageId.toLowerCase());
  } catch {
    return undefined;
  }
};

/** Confirms that a Page projection uses the exact precomposition from this assembled context. */
export const isTrustedInstalledPageComposition = (
  contextCandidate: unknown,
  compositionCandidate: unknown,
): compositionCandidate is ResolvedPageComposition => {
  if (typeof compositionCandidate !== "object" || compositionCandidate === null) return false;
  try {
    const context = requireInstalledRuntimeContext(contextCandidate);
    const compositions = installedPageCompositions.get(context);
    return (
      compositions !== undefined &&
      [...compositions.values()].some((composition) => composition === compositionCandidate)
    );
  } catch {
    return false;
  }
};

/** Matches the exact source and active pins used to assemble this Page context. */
export const matchesInstalledPageBundleIdentity = (
  contextCandidate: unknown,
  stateCandidate: unknown,
  expectedAccessVersion?: number,
  expectedOrganizationAccountId?: string,
): boolean => {
  try {
    const context = requireInstalledRuntimeContext(contextCandidate);
    const expected = installedPageBundleIdentities.get(context);
    const parsed = activeInstallationBundleStateSchema.safeParse(stateCandidate);
    if (expected === undefined || !parsed.success) return false;
    const state = parsed.data;
    const bundleIndex = state.bundleIndex;
    if (state.repairNeeded || bundleIndex === null) return false;
    const application = context.releaseSet.application;
    if (
      state.identity.organizationId !== expected.organizationId ||
      state.identity.applicationRootId !== expected.applicationRootId ||
      state.identity.applicationReleaseRevision !== expected.applicationReleaseRevision ||
      (expectedAccessVersion !== undefined &&
        state.identity.accessVersion !== expectedAccessVersion) ||
      (expectedOrganizationAccountId !== undefined &&
        state.identity.organizationAccountId !== expectedOrganizationAccountId) ||
      state.identity.pinFingerprint !== expected.pinFingerprint ||
      bundleIndex.pinFingerprint !== expected.pinFingerprint ||
      canonicalJson(bundleIndex.sourceManifest) !== canonicalJson(expected.sourceManifest) ||
      application.organizationId !== state.identity.organizationId ||
      application.rootId !== state.identity.applicationRootId ||
      application.releaseRevision !== state.identity.applicationReleaseRevision ||
      application.definitionKey !== state.identity.registeredApplication.definitionKey ||
      application.releaseVersion !== state.identity.registeredApplication.releaseVersion ||
      application.validationContractVersion !==
        state.identity.registeredApplication.validationContractVersion ||
      application.contentFingerprint !== state.identity.registeredApplication.contentFingerprint ||
      application.resolutionFingerprint !==
        state.identity.registeredApplication.resolutionFingerprint ||
      canonicalJson(state.identity.moduleBindings) !== canonicalJson(expected.moduleBindings) ||
      canonicalJson(state.identity.pinFacts) !== canonicalJson(expected.pinFacts)
    )
      return false;
    const modules = [...context.releaseSet.modules].sort((left, right) =>
      left.rootId.toLowerCase() < right.rootId.toLowerCase()
        ? -1
        : left.rootId.toLowerCase() > right.rootId.toLowerCase()
          ? 1
          : 0,
    );
    if (modules.length !== state.identity.pinFacts.length) return false;
    return modules.every((module, index) => {
      const binding = state.identity.moduleBindings[index];
      const pin = state.identity.pinFacts[index];
      return (
        binding !== undefined &&
        pin !== undefined &&
        module.organizationId === state.identity.organizationId &&
        module.rootId === binding.moduleRootId &&
        module.releaseRevision === binding.moduleReleaseRevision &&
        module.rootId === pin.moduleRootId &&
        module.releaseRevision === pin.moduleReleaseRevision &&
        module.contentFingerprint === pin.contentFingerprint &&
        module.resolutionFingerprint === pin.resolutionFingerprint
      );
    });
  } catch {
    return false;
  }
};
