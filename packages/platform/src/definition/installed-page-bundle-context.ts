import "server-only";

import type { PreparedApplicationPermissionRegistration } from "../access/permission-registry";
import type { ResolvedPageComposition } from "../pages/page-composition-resolution";
import { canonicalJson } from "./canonical-json";
import {
  systemApplicationBoundReleaseSetResultSchema,
  type SystemApplicationBoundReleaseSetResult,
} from "./definition-consumer-read";
import {
  installationRuntimeBundleFormatVersion,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundlePagesSectionSchema,
  installationRuntimeBundleSections,
  type InstallationRuntimeBundleSourceManifest,
} from "./installation-runtime-bundle";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import {
  activeInstallationBundleStateSchema,
  type ActiveInstallationBundleState,
} from "./active-installation-bundle-repository";
import {
  activeApplicationInstallationSchema,
  type ActiveApplicationInstallation,
} from "../files/storage";
import {
  readInstallationRuntimeBundleSections,
  type InstallationRuntimeBundleSections,
} from "./installation-runtime-bundle-app";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";
import { z } from "zod";
import {
  assembleHumanInstalledRuntimeContext,
  readHumanActiveInstallation,
  isInstalledRuntimeContext,
  type HumanInstalledRuntimeScope,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";
import { readInstalledRecordContributions } from "./installed-record-contributions";
import { flowPlansOf } from "../workflows/flow-plan";

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
  // The reader returns parsed JSON; the section's contract below checks its shape.
  const value = sections[section];
  if (value === undefined) throw new Error("INSTALLED_PAGE_BUNDLE_SECTION_UNAVAILABLE");
  return value;
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
  // The release's flow plans are built once, with the bundle, and shared by every request.
  flowPlansOf(releaseSet);
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

type ActiveBundleStateRow = DatabaseRow & { readonly bundle_state: unknown };

type ActiveInstallationBundleErrorCode =
  | "ACTIVE_INSTALLATION_BUNDLE_REFUSED"
  | "ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE"
  | "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED"
  | "ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED";

const activeBundleFailure = (
  error: unknown,
): DefinitionError<ActiveInstallationBundleErrorCode> => {
  if (error instanceof DefinitionError) return error;
  const kind = classifyDatabaseError(error);
  if (kind === "refused" || kind === "invalid")
    return new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_REFUSED", { cause: error });
  if (kind === "not_found")
    return new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE", { cause: error });
  return unexpectedDefinitionFailure(
    "ACTIVE_INSTALLATION_BUNDLE_STORAGE_FAILED",
    error,
    "installed-page-bundle-context",
  );
};

/** Reads the active format-2 bundle state under the verified HUMAN request transaction. */
const readActiveInstallationBundleState = async (
  transaction: RequestDatabaseTransaction,
): Promise<ActiveInstallationBundleState> => {
  try {
    const rows = await transaction.query<ActiveBundleStateRow>`
      select vortex_definition.read_active_installation_bundle_identity() as bundle_state
    `;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
    const parsed = activeInstallationBundleStateSchema.safeParse(rows[0].bundle_state);
    if (!parsed.success)
      throw unexpectedDefinitionFailure(
        "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
        parsed.error,
        "installed-page-bundle-context",
      );
    const roots = parsed.data.identity.moduleBindings.map((binding) => binding.moduleRootId);
    if (
      new Set(roots.map((root) => root.toLowerCase())).size !== roots.length ||
      parsed.data.identity.moduleBindings.some(
        (binding, index) =>
          index > 0 && roots[index - 1]!.toLowerCase() >= binding.moduleRootId.toLowerCase(),
      )
    )
      throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED");
    return parsed.data;
  } catch (error) {
    throw activeBundleFailure(error);
  }
};

const activeInstallationEvidence = (
  state: ActiveInstallationBundleState,
): ActiveApplicationInstallation => {
  const identity = state.identity;
  const installation = activeApplicationInstallationSchema.safeParse({
    organizationId: identity.organizationId,
    applicationRootId: identity.applicationRootId,
    applicationReleaseRevision: identity.applicationReleaseRevision,
    moduleBindings: identity.moduleBindings.map((binding) => ({
      organizationId: identity.organizationId,
      applicationRootId: identity.applicationRootId,
      applicationReleaseRevision: identity.applicationReleaseRevision,
      moduleRootId: binding.moduleRootId,
      bindingRevision: binding.bindingRevision,
      moduleReleaseRevision: binding.moduleReleaseRevision,
      state: binding.state,
    })),
  });
  if (!installation.success)
    throw unexpectedDefinitionFailure(
      "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
      installation.error,
      "installed-page-bundle-context",
    );
  return installation.data;
};

const readActiveInstallationBundleSections = async (
  transaction: RequestDatabaseTransaction,
  state: ActiveInstallationBundleState,
): Promise<InstallationRuntimeBundleSections> => {
  if (state.bundleIndex === null)
    throw new DefinitionError("ACTIVE_INSTALLATION_BUNDLE_UNAVAILABLE");
  try {
    const keyCandidate = installationRuntimeBundleKeySchema.safeParse({
      applicationRootId: state.identity.applicationRootId,
      applicationReleaseRevision: state.identity.applicationReleaseRevision,
      bundleFormatVersion: installationRuntimeBundleFormatVersion,
    });
    if (!keyCandidate.success)
      throw unexpectedDefinitionFailure(
        "ACTIVE_INSTALLATION_BUNDLE_INTEGRITY_FAILED",
        keyCandidate.error,
        "installed-page-bundle-context",
      );
    return await readInstallationRuntimeBundleSections(
      transaction,
      keyCandidate.data,
      installationRuntimeBundleSections,
    );
  } catch (error) {
    throw activeBundleFailure(error);
  }
};

type HumanInstalledPageBundleContextDependencies = Readonly<{
  transaction: RequestDatabaseTransaction;
  scope: HumanInstalledRuntimeScope;
}>;

/** The one loader every request scope reaches the installed context through. */
export const createInstalledContextLoader = (
  transaction: RequestDatabaseTransaction,
  scope: Readonly<{
    organizationId: string;
    organizationAccountId: string;
    applicationRootId?: string | undefined;
    previewInstallationId?: string | undefined;
  }>,
) => {
  if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
  return createHumanInstalledPageBundleContextLoader({
    transaction,
    scope: {
      organizationId: scope.organizationId,
      organizationAccountId: scope.organizationAccountId,
      applicationRootId: scope.applicationRootId,
      ...(scope.previewInstallationId === undefined
        ? {}
        : { previewInstallationId: scope.previewInstallationId }),
    },
  });
};

/**
 * Builds the genuine current HUMAN Page context from the cached installed release. Only the active
 * installation identity is read per request; the bundle is read and validated once per immutable
 * release. A missing bundle is an install or activation defect and fails here instead of being repaired.
 */
const createHumanInstalledPageBundleContextLoader = (
  dependencies: HumanInstalledPageBundleContextDependencies,
) => {
  return Object.freeze({
    async load(): Promise<InstalledRuntimeContext> {
      // A preview request runs the preview's stored release set, never the live bundle.
      if (dependencies.scope.previewInstallationId !== undefined) {
        const { loadHumanPreviewRuntimeContext } = await import("./preview-runtime-context");
        return loadHumanPreviewRuntimeContext(dependencies.transaction, dependencies.scope);
      }
      const statePromise = readActiveInstallationBundleState(dependencies.transaction);
      // The installed bundle is immutable, but what other installed Modules contribute to its
      // record types changes with their installations, so it is read with every request. It does
      // not depend on the bundle, so it is sent with the bundle state and consulted after it.
      const contributionsRead = readInstalledRecordContributions(dependencies.transaction);
      void contributionsRead.catch(() => undefined);
      const installation = await readHumanActiveInstallation(
        statePromise.then(activeInstallationEvidence),
        dependencies.scope,
      );
      const state = await statePromise;
      const bundleIndex = state.bundleIndex;
      if (bundleIndex === null) throw new Error("INSTALLED_PAGE_BUNDLE_INDEX_UNAVAILABLE");
      const key = installedPageBundleKey(state.identity);
      const cached = installedPageBundles.get(key);
      let bundle: InstalledPageBundle;
      if (cached === undefined) {
        const { sections, textLength } = await readActiveInstallationBundleSections(
          dependencies.transaction,
          state,
        );
        bundle = bundleFromSections(sections, state.identity.correlationId);
        identityMatchesReleaseSet(state, bundle.releaseSet);
        retainInstalledPageBundle(key, bundle, textLength);
      } else {
        bundle = cached.bundle;
        retainInstalledPageBundle(key, bundle, cached.size);
      }
      const contributions = await contributionsRead;
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
  return (
    isInstalledRuntimeContext(contextCandidate) &&
    installedPageBundleIdentities.has(contextCandidate)
  );
};

/** Returns only the canonical precomposition held by this request's assembled App context. */
export const readInstalledPageComposition = (
  contextCandidate: unknown,
  pageId: string,
): ResolvedPageComposition | undefined => {
  if (!isInstalledRuntimeContext(contextCandidate)) return undefined;
  return installedPageCompositions.get(contextCandidate)?.get(pageId.toLowerCase());
};

/** Confirms that a Page projection uses the exact precomposition from this assembled context. */
export const isTrustedInstalledPageComposition = (
  contextCandidate: unknown,
  compositionCandidate: unknown,
): compositionCandidate is ResolvedPageComposition => {
  if (typeof compositionCandidate !== "object" || compositionCandidate === null) return false;
  if (!isInstalledRuntimeContext(contextCandidate)) return false;
  const compositions = installedPageCompositions.get(contextCandidate);
  return (
    compositions !== undefined &&
    [...compositions.values()].some((composition) => composition === compositionCandidate)
  );
};

/** Matches the exact source and active pins used to assemble this Page context. */
export const matchesInstalledPageBundleIdentity = (
  contextCandidate: unknown,
  stateCandidate: unknown,
  expectedAccessVersion?: number,
  expectedOrganizationAccountId?: string,
): boolean => {
  if (!isInstalledRuntimeContext(contextCandidate)) return false;
  const context = contextCandidate;
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
};
