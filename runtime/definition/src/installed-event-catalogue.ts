import {
  applicationDefinitionConsumerReadResultV1Schema,
  applicationDefinitionConsumerReadResultV2Schema,
  applicationRootIdSchema,
  installedEventDescriptorSchema,
  moduleDefinitionConsumerReadResultV1Schema,
  moduleDefinitionConsumerReadResultV2Schema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  type DefinitionConsumerReadResult,
  type InstalledEventDescriptor,
} from "@vortex/contracts";
import { z } from "zod";
import {
  canonicalJson,
  compareCanonicalStrings,
  fingerprintCanonicalValue,
} from "./canonical-json";

type ApplicationRead = Extract<DefinitionConsumerReadResult, { kind: "application" }>;
type ModuleRead = Extract<DefinitionConsumerReadResult, { kind: "module" }>;
type ModuleRecordType = ModuleRead["content"]["recordTypes"][number];

const applicationReadSchema = z.union([
  applicationDefinitionConsumerReadResultV1Schema,
  applicationDefinitionConsumerReadResultV2Schema,
]);
const moduleReadSchema = z.union([
  moduleDefinitionConsumerReadResultV1Schema,
  moduleDefinitionConsumerReadResultV2Schema,
]);

/**
 * Evidence read from the Module installation binding owner. It is input to this
 * pure projector, not caller-authored readiness or authentication evidence.
 */
const installedEventBindingEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    moduleRootId: moduleRootIdSchema,
    bindingRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
    applicationReleaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
    moduleReleaseRevision: revisionSchema.max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["provisioned", "active", "detached"]),
  })
  .strict();

export type InstalledEventBindingEvidence = z.infer<typeof installedEventBindingEvidenceSchema>;

export type InstalledEventCatalogueInput = Readonly<{
  application: unknown;
  modules: readonly unknown[];
  bindings: readonly unknown[];
}>;

type ExactRelease = Readonly<{
  rootId: string;
  releaseRevision: number;
  releaseVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

export type InstalledEventCatalogue = Readonly<{
  organizationId: string;
  application: ExactRelease;
  moduleBindings: readonly Readonly<{
    bindingRevision: number;
    release: ExactRelease;
  }>[];
  descriptors: readonly InstalledEventDescriptor[];
}>;

export const installedEventCatalogueErrorCodes = [
  "INVALID_INSTALLED_EVENT_INPUT",
  "INSTALLED_EVENT_BINDING_INACTIVE",
  "INSTALLED_EVENT_RELEASE_MISMATCH",
  "INSTALLED_EVENT_DEPENDENCY_MISMATCH",
  "INSTALLED_EVENT_DEFINITION_INVALID",
] as const;

export type InstalledEventCatalogueErrorCode = (typeof installedEventCatalogueErrorCodes)[number];

export class InstalledEventCatalogueError extends Error {
  readonly code: InstalledEventCatalogueErrorCode;

  constructor(code: InstalledEventCatalogueErrorCode) {
    super(code);
    this.name = "InstalledEventCatalogueError";
    this.code = code;
  }
}

const releaseOf = (read: ApplicationRead | ModuleRead): ExactRelease => ({
  rootId: read.rootId,
  releaseRevision: read.releaseRevision,
  releaseVersion: read.releaseVersion,
  contentFingerprint: read.contentFingerprint,
  resolutionFingerprint: read.resolutionFingerprint,
});

const dependencyMatchesRead = (
  dependency: Extract<ApplicationRead["dependencyManifest"][number], { kind: "module" }>,
  read: ModuleRead,
): boolean =>
  dependency.key === read.definitionKey &&
  dependency.rootId === read.rootId &&
  dependency.releaseRevision === read.releaseRevision &&
  dependency.releaseVersion === read.releaseVersion &&
  dependency.contentFingerprint === read.contentFingerprint &&
  dependency.resolutionFingerprint === read.resolutionFingerprint;

const standardKinds = [
  "created",
  "changed",
  "deleted",
  "linked",
  "unlinked",
  "reassigned",
  "state_changed",
] as const;

const descriptorKey = (descriptor: InstalledEventDescriptor): string => canonicalJson(descriptor);

export type InstalledEventDefinitionContext = Readonly<{
  application: ApplicationRead;
  modules: readonly ModuleRead[];
  bindings: readonly InstalledEventBindingEvidence[];
  catalogue: InstalledEventCatalogue;
  recordTypes: ReadonlyMap<string, Readonly<{ module: ModuleRead; recordType: ModuleRecordType }>>;
}>;

/** Verifies and exposes exact installed Definition context to higher pure consumers. */
export const resolveInstalledEventDefinitionContext = (
  input: InstalledEventCatalogueInput,
): InstalledEventDefinitionContext => {
  const application = applicationReadSchema.safeParse(input.application);
  const modules = z.array(moduleReadSchema).safeParse(input.modules);
  const bindings = z.array(installedEventBindingEvidenceSchema).safeParse(input.bindings);
  if (!application.success || !modules.success || !bindings.success)
    throw new InstalledEventCatalogueError("INVALID_INSTALLED_EVENT_INPUT");

  const app = application.data;
  const moduleReads = modules.data;
  const bindingEvidence = bindings.data;
  if (
    fingerprintCanonicalValue(app.content) !== app.contentFingerprint ||
    moduleReads.some(
      (module) =>
        module.organizationId !== app.organizationId ||
        fingerprintCanonicalValue(module.content) !== module.contentFingerprint,
    )
  )
    throw new InstalledEventCatalogueError("INSTALLED_EVENT_RELEASE_MISMATCH");
  if (bindingEvidence.some((binding) => binding.state !== "active"))
    throw new InstalledEventCatalogueError("INSTALLED_EVENT_BINDING_INACTIVE");

  const modulesByRoot = new Map(moduleReads.map((module) => [String(module.rootId), module]));
  const bindingsByRoot = new Map(
    bindingEvidence.map((binding) => [String(binding.moduleRootId), binding]),
  );
  if (
    modulesByRoot.size !== moduleReads.length ||
    bindingsByRoot.size !== bindingEvidence.length ||
    moduleReads.length !== app.content.moduleBindings.length ||
    bindingEvidence.length !== app.content.moduleBindings.length
  )
    throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEPENDENCY_MISMATCH");

  const applicationModuleDependencies = app.dependencyManifest.filter(
    (dependency): dependency is Extract<typeof dependency, { kind: "module" }> =>
      dependency.kind === "module",
  );
  if (applicationModuleDependencies.length !== app.content.moduleBindings.length)
    throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEPENDENCY_MISMATCH");

  for (const declaredBinding of app.content.moduleBindings) {
    const module = modulesByRoot.get(String(declaredBinding.moduleRootId));
    const binding = bindingsByRoot.get(String(declaredBinding.moduleRootId));
    const dependency = applicationModuleDependencies.find(
      (entry) => entry.rootId === declaredBinding.moduleRootId,
    );
    if (
      module === undefined ||
      binding === undefined ||
      dependency === undefined ||
      declaredBinding.resolvedVersion !== module.releaseVersion ||
      !dependencyMatchesRead(dependency, module) ||
      binding.organizationId !== app.organizationId ||
      binding.applicationRootId !== app.rootId ||
      binding.applicationReleaseRevision !== app.releaseRevision ||
      binding.moduleReleaseRevision !== module.releaseRevision
    )
      throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEPENDENCY_MISMATCH");
  }

  for (const module of moduleReads) {
    const declaredDependencies = module.content.dependencies;
    const manifestDependencies = module.dependencyManifest.filter(
      (dependency): dependency is Extract<typeof dependency, { kind: "module" }> =>
        dependency.kind === "module",
    );
    if (
      manifestDependencies.length !== module.dependencyManifest.length ||
      manifestDependencies.length !== declaredDependencies.length
    )
      throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEPENDENCY_MISMATCH");
    for (const declaredDependency of declaredDependencies) {
      const dependency = manifestDependencies.find(
        (entry) => entry.rootId === declaredDependency.moduleRootId,
      );
      const target = modulesByRoot.get(String(declaredDependency.moduleRootId));
      if (
        dependency === undefined ||
        target === undefined ||
        declaredDependency.moduleKey !== target.definitionKey ||
        declaredDependency.resolvedVersion !== target.releaseVersion ||
        !dependencyMatchesRead(dependency, target)
      )
        throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEPENDENCY_MISMATCH");
    }
  }

  const recordTypes = new Map<
    string,
    Readonly<{ module: ModuleRead; recordType: ModuleRecordType }>
  >();
  for (const module of moduleReads)
    for (const recordType of module.content.recordTypes) {
      if (recordTypes.has(String(recordType.recordTypeId)))
        throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEFINITION_INVALID");
      recordTypes.set(String(recordType.recordTypeId), { module, recordType });
    }

  const descriptors: InstalledEventDescriptor[] = [];
  for (const { recordType } of recordTypes.values())
    for (const eventKind of standardKinds)
      descriptors.push(
        installedEventDescriptorSchema.parse({
          kind: "standard",
          eventKind,
          recordTypeId: recordType.recordTypeId,
        }),
      );

  const appendDeclarations = (
    owner:
      { kind: "application"; applicationRootId: string } | { kind: "module"; moduleRootId: string },
    events: ApplicationRead["content"]["events"] | ModuleRead["content"]["events"],
  ) => {
    for (const event of events) {
      const record = recordTypes.get(String(event.recordTypeId));
      if (
        record === undefined ||
        (owner.kind === "module" && record.module.rootId !== owner.moduleRootId)
      )
        throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEFINITION_INVALID");
      const fields = new Map(
        record.recordType.fields.map((field) => [String(field.fieldId), field] as const),
      );
      if (
        event.personalOrSensitiveValuesAllowed !== false ||
        event.carriedFieldIds.some(
          (fieldId) => fields.get(String(fieldId))?.personalData !== "none",
        )
      )
        throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEFINITION_INVALID");
      descriptors.push(
        installedEventDescriptorSchema.parse({
          kind: "declared",
          owner,
          declarationId: event.eventId,
          key: event.key,
          recordTypeId: event.recordTypeId,
          carriedFieldIds: [...event.carriedFieldIds].sort(compareCanonicalStrings),
        }),
      );
    }
  };

  appendDeclarations({ kind: "application", applicationRootId: app.rootId }, app.content.events);
  for (const module of moduleReads)
    appendDeclarations({ kind: "module", moduleRootId: module.rootId }, module.content.events);

  descriptors.sort((left, right) =>
    compareCanonicalStrings(descriptorKey(left), descriptorKey(right)),
  );
  const ownerQualified = (descriptor: Extract<InstalledEventDescriptor, { kind: "declared" }>) =>
    descriptor.owner.kind === "application"
      ? `application:${descriptor.owner.applicationRootId}`
      : `module:${descriptor.owner.moduleRootId}`;
  const declaredIds = descriptors.flatMap((descriptor) =>
    descriptor.kind === "declared"
      ? [`${ownerQualified(descriptor)}:${descriptor.declarationId}`]
      : [],
  );
  const declaredKeys = descriptors.flatMap((descriptor) =>
    descriptor.kind === "declared" ? [`${ownerQualified(descriptor)}:${descriptor.key}`] : [],
  );
  if (
    new Set(descriptors.map(descriptorKey)).size !== descriptors.length ||
    new Set(declaredIds).size !== declaredIds.length ||
    new Set(declaredKeys).size !== declaredKeys.length
  )
    throw new InstalledEventCatalogueError("INSTALLED_EVENT_DEFINITION_INVALID");

  const moduleBindings = bindingEvidence
    .map((binding) => ({
      bindingRevision: binding.bindingRevision,
      release: releaseOf(modulesByRoot.get(String(binding.moduleRootId))!),
    }))
    .sort((left, right) => compareCanonicalStrings(left.release.rootId, right.release.rootId));
  return {
    application: app,
    modules: moduleReads,
    bindings: bindingEvidence,
    recordTypes,
    catalogue: {
      organizationId: app.organizationId,
      application: releaseOf(app),
      moduleBindings,
      descriptors,
    },
  };
};

/** Projects the exact active installation into a deterministic, non-persisted event catalogue. */
export const projectInstalledEventCatalogue = (
  input: InstalledEventCatalogueInput,
): InstalledEventCatalogue => resolveInstalledEventDefinitionContext(input).catalogue;
