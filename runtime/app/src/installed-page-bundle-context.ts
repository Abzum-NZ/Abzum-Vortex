import "server-only";

import {
  canonicalJson,
  installationPreparedRecordAccessPlanSchema,
  installationRuntimeBundlePagesSectionSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleSourceManifestSchema,
  jsonValueSchema,
  type InstallationRuntimeBundleSourceManifest,
  systemApplicationBoundReleaseSetResultSchema,
  type ResolvedPageComposition,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createActiveInstallationBundleRepository,
  activeInstallationBundleStateSchema,
  type ActiveInstallationBundleState,
} from "@vortex/module";
import { z } from "zod";
import { buildInstallationRuntimeBundleWriteCommand } from "./installation-runtime-bundle";
import {
  createHumanInstalledRuntimeContextLoader,
  requireInstalledRuntimeContext,
  type HumanInstalledRuntimeContextDependencies,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";

const coldSourceSchema = z.object({
  sourceManifest: installationRuntimeBundleSourceManifestSchema,
  preparedRecordAccessPlan: installationPreparedRecordAccessPlanSchema,
}).passthrough();

type InstalledPageBundleIdentityEvidence = Readonly<{
  organizationId: ActiveInstallationBundleState["identity"]["organizationId"];
  applicationRootId: ActiveInstallationBundleState["identity"]["applicationRootId"];
  applicationReleaseRevision: ActiveInstallationBundleState["identity"]["applicationReleaseRevision"];
  pinFingerprint: ActiveInstallationBundleState["identity"]["pinFingerprint"];
  moduleBindings: ActiveInstallationBundleState["identity"]["moduleBindings"];
  pinFacts: ActiveInstallationBundleState["identity"]["pinFacts"];
  sourceManifest: InstallationRuntimeBundleSourceManifest;
}>;

const requireSection = <Section extends (typeof installationRuntimeBundleSections)[number]>(
  sections: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
  section: Section,
): unknown => {
  const parsed = jsonValueSchema.safeParse(sections[section]);
  if (!parsed.success) throw new Error("INSTALLED_PAGE_BUNDLE_SECTION_UNAVAILABLE");
  return parsed.data;
};

const releaseSetFromSections = (
  sections: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
  correlationId: string,
): SystemApplicationBoundReleaseSetResult => {
  const pages = installationRuntimeBundlePagesSectionSchema.parse(requireSection(sections, "pages"));
  const flows = z.object({ flows: z.array(z.unknown()), flowBindings: z.array(z.unknown()) }).strict()
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
  return systemApplicationBoundReleaseSetResultSchema.parse({
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
  });
};

const pageCompositions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  sections: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
): ReadonlyMap<string, ResolvedPageComposition> => {
  const pages = installationRuntimeBundlePagesSectionSchema.parse(requireSection(sections, "pages"));
  const application = releaseSet.application;
  if (pages.resolvedCompositions.length !== application.content.pages.length)
    throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
  const result = new Map<string, ResolvedPageComposition>();
  for (const [index, composition] of pages.resolvedCompositions.entries()) {
    const page = application.content.pages[index];
    if (page === undefined || page.pageId !== composition.pageId)
      throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
    const key = composition.pageId.toLowerCase();
    if (result.has(key)) throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
    result.set(key, deepFreeze({ page, roots: composition.roots }));
  }
  return result;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  Object.freeze(value);
  return value;
};

const compareSections = (
  actual: Readonly<Partial<Record<(typeof installationRuntimeBundleSections)[number], unknown>>>,
  expected: Readonly<Record<(typeof installationRuntimeBundleSections)[number], unknown>>,
): void => {
  for (const section of installationRuntimeBundleSections)
    if (canonicalJson(requireSection(actual, section)) !== canonicalJson(expected[section]))
      throw new Error("INSTALLED_PAGE_BUNDLE_CONTENT_MISMATCH");
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
    application.validationContractVersion !== identity.registeredApplication.validationContractVersion ||
    application.contentFingerprint !== identity.registeredApplication.contentFingerprint ||
    application.resolutionFingerprint !== identity.registeredApplication.resolutionFingerprint
  ) throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  const modules = [...releaseSet.modules].sort((left, right) =>
    left.rootId.toLowerCase() < right.rootId.toLowerCase() ? -1
      : left.rootId.toLowerCase() > right.rootId.toLowerCase() ? 1 : 0,
  );
  if (modules.length !== identity.moduleBindings.length)
    throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  for (const [index, module] of modules.entries()) {
    const binding = identity.moduleBindings[index];
    const pin = identity.pinFacts[index];
    if (
      binding === undefined || pin === undefined ||
      module.organizationId !== identity.organizationId ||
      module.correlationId !== identity.correlationId ||
      module.rootId !== binding.moduleRootId ||
      module.releaseRevision !== binding.moduleReleaseRevision ||
      module.rootId !== pin.moduleRootId ||
      module.releaseRevision !== pin.moduleReleaseRevision ||
      module.contentFingerprint !== pin.contentFingerprint ||
      module.resolutionFingerprint !== pin.resolutionFingerprint
    ) throw new Error("INSTALLED_PAGE_BUNDLE_SOURCE_MISMATCH");
  }
};

export type HumanInstalledPageBundleContextDependencies =
  Omit<HumanInstalledRuntimeContextDependencies, "activeInstallationReader"> & Readonly<{
    transaction: RequestDatabaseTransaction;
    /** The protected, request-bound Definition consumer used only on a genuine cold repair. */
    releaseSetReader: HumanInstalledRuntimeContextDependencies["releaseSetReader"];
  }>;

/** Builds the genuine current HUMAN Page context from a verified warm bundle or one cold repair. */
export const createHumanInstalledPageBundleContextLoader = (
  dependencies: HumanInstalledPageBundleContextDependencies,
) => {
  const repository = createActiveInstallationBundleRepository(dependencies.transaction);
  let compositions: ReadonlyMap<string, ResolvedPageComposition> | undefined;
  let bundleIdentityEvidence: InstalledPageBundleIdentityEvidence | undefined;
  const loader = createHumanInstalledRuntimeContextLoader({
    activeInstallationReader: repository,
    scope: dependencies.scope,
    releaseSetReader: {
      async read(command) {
        const state = await repository.readCurrentState();
        if (
          state.identity.organizationId !== dependencies.scope.organizationId ||
          state.identity.applicationRootId !== dependencies.scope.applicationRootId ||
          state.identity.applicationReleaseRevision !== command.applicationReleaseRevision
        ) throw new Error("INSTALLED_PAGE_BUNDLE_SCOPE_UNAVAILABLE");

        if (!state.repairNeeded) {
          const storedSections = await repository.readSections(state);
          const releaseSet = releaseSetFromSections(storedSections, state.identity.correlationId);
          identityMatchesReleaseSet(state, releaseSet);
          const accessPlan = z.object({
            preparedRecordAccessPlan: installationPreparedRecordAccessPlanSchema,
          }).passthrough().safeParse(requireSection(storedSections, "access_plan"));
          const prepared = accessPlan.success
            ? installationPreparedRecordAccessPlanSchema.safeParse(accessPlan.data.preparedRecordAccessPlan)
            : undefined;
          if (prepared === undefined || !prepared.success)
            throw new Error("INSTALLED_PAGE_BUNDLE_PLAN_UNAVAILABLE");
          const bundleIndex = state.bundleIndex;
          if (bundleIndex === null)
            throw new Error("INSTALLED_PAGE_BUNDLE_INDEX_UNAVAILABLE");
          const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
            bundleIndex.sourceManifest,
          );
          const expected = buildInstallationRuntimeBundleWriteCommand({
            releaseSet,
            sourceManifest,
            preparedRecordAccessPlan: prepared.data,
          });
          compareSections(storedSections, expected.sections);
          compositions = pageCompositions(releaseSet, storedSections);
          bundleIdentityEvidence = deepFreeze({
            organizationId: state.identity.organizationId,
            applicationRootId: state.identity.applicationRootId,
            applicationReleaseRevision: state.identity.applicationReleaseRevision,
            pinFingerprint: state.identity.pinFingerprint,
            moduleBindings: state.identity.moduleBindings,
            pinFacts: state.identity.pinFacts,
            sourceManifest,
          });
          return releaseSet;
        }

        const coldSource = coldSourceSchema.safeParse(state.coldSource);
        if (!coldSource.success)
          throw new Error("INSTALLED_PAGE_BUNDLE_COLD_SOURCE_UNAVAILABLE");
        const releaseSet = systemApplicationBoundReleaseSetResultSchema.parse(
          await dependencies.releaseSetReader.read({
            applicationReleaseRevision: command.applicationReleaseRevision,
          }),
        );
        identityMatchesReleaseSet(state, releaseSet);
        const source = {
          releaseSet,
          sourceManifest: coldSource.data.sourceManifest,
          preparedRecordAccessPlan: coldSource.data.preparedRecordAccessPlan,
        };
        const expected = buildInstallationRuntimeBundleWriteCommand(source);
        const repairedIndex = await repository.repair(state, expected);
        const repairedSections = await repository.readSections(state, repairedIndex);
        compareSections(repairedSections, expected.sections);
        compositions = pageCompositions(releaseSet, repairedSections);
        bundleIdentityEvidence = deepFreeze({
          organizationId: state.identity.organizationId,
          applicationRootId: state.identity.applicationRootId,
          applicationReleaseRevision: state.identity.applicationReleaseRevision,
          pinFingerprint: state.identity.pinFingerprint,
          moduleBindings: state.identity.moduleBindings,
          pinFacts: state.identity.pinFacts,
          sourceManifest: repairedIndex.sourceManifest,
        });
        return releaseSet;
      },
    },
  });

  return Object.freeze({
    async load(): Promise<InstalledRuntimeContext> {
      const context = await loader.load();
      if (compositions === undefined || bundleIdentityEvidence === undefined)
        throw new Error("INSTALLED_PAGE_BUNDLE_COMPOSITION_UNAVAILABLE");
      return retainPageCompositions(context, compositions, bundleIdentityEvidence);
    },
  });
};

const installedPageCompositions = new WeakMap<object, ReadonlyMap<string, ResolvedPageComposition>>();
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
    return compositions !== undefined &&
      [...compositions.values()].some((composition) => composition === compositionCandidate);
  } catch {
    return false;
  }
};

/** Matches the exact source and active pins used to assemble this Page context. */
export const matchesInstalledPageBundleIdentity = (
  contextCandidate: unknown,
  stateCandidate: unknown,
  expectedAccessVersion?: number,
): boolean => {
  try {
    const context = requireInstalledRuntimeContext(contextCandidate);
    const expected = installedPageBundleIdentities.get(context);
    const parsed = activeInstallationBundleStateSchema.safeParse(stateCandidate);
    if (expected === undefined || !parsed.success || parsed.data.repairNeeded ||
      parsed.data.bundleIndex === null) return false;
    const state = parsed.data;
    const application = context.releaseSet.application;
    if (
      state.identity.organizationId !== expected.organizationId ||
      state.identity.applicationRootId !== expected.applicationRootId ||
      state.identity.applicationReleaseRevision !== expected.applicationReleaseRevision ||
      (expectedAccessVersion !== undefined &&
        state.identity.accessVersion !== expectedAccessVersion) ||
      state.identity.pinFingerprint !== expected.pinFingerprint ||
      state.bundleIndex.pinFingerprint !== expected.pinFingerprint ||
      canonicalJson(state.bundleIndex.sourceManifest) !== canonicalJson(expected.sourceManifest) ||
      application.organizationId !== state.identity.organizationId ||
      application.rootId !== state.identity.applicationRootId ||
      application.releaseRevision !== state.identity.applicationReleaseRevision ||
      application.definitionKey !== state.identity.registeredApplication.definitionKey ||
      application.releaseVersion !== state.identity.registeredApplication.releaseVersion ||
      application.validationContractVersion !== state.identity.registeredApplication.validationContractVersion ||
      application.contentFingerprint !== state.identity.registeredApplication.contentFingerprint ||
      application.resolutionFingerprint !== state.identity.registeredApplication.resolutionFingerprint ||
      canonicalJson(state.identity.moduleBindings) !== canonicalJson(expected.moduleBindings) ||
      canonicalJson(state.identity.pinFacts) !== canonicalJson(expected.pinFacts)
    ) return false;
    const modules = [...context.releaseSet.modules].sort((left, right) =>
      left.rootId.toLowerCase() < right.rootId.toLowerCase() ? -1
        : left.rootId.toLowerCase() > right.rootId.toLowerCase() ? 1 : 0,
    );
    if (modules.length !== state.identity.pinFacts.length) return false;
    return modules.every((module, index) => {
      const binding = state.identity.moduleBindings[index];
      const pin = state.identity.pinFacts[index];
      return binding !== undefined && pin !== undefined &&
        module.organizationId === state.identity.organizationId &&
        module.rootId === binding.moduleRootId &&
        module.releaseRevision === binding.moduleReleaseRevision &&
        module.rootId === pin.moduleRootId &&
        module.releaseRevision === pin.moduleReleaseRevision &&
        module.contentFingerprint === pin.contentFingerprint &&
        module.resolutionFingerprint === pin.resolutionFingerprint;
    });
  } catch {
    return false;
  }
};

