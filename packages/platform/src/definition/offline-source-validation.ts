import "server-only";

import { createHash } from "node:crypto";
import {
  definitionCompilationOutputSchema,
  moduleCompilationRequestSchema,
  moduleSourceDocumentSchema,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type DefinitionValidationLocation,
  type ModuleSourceDocument,
  type StoredDefinitionSource,
} from "../schema";
import { describeFailure } from "../catalogue/runtime-primitives";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json-definition";
import { compileParsedDefinition } from "./compiler";
import { DefinitionCompilationError } from "./compilation-error";
import { extractModuleSourceIdentityRequirements } from "./source-identities";
import { validateDefinitionSet } from "./validation";
import { moduleDependencies } from "./module-dependencies";

/** One reason a shipped source would be refused at publication, located on the offending part. */
export type OfflineSourceFailure = Readonly<{
  definitionKey: string;
  stage: "source_schema" | "compile" | "validation" | "resolution";
  /** A stable reason code: a compiler rule code, or `offline_unexpected_failure`. */
  code: string;
  /** Where in the source the refusal is located, as readable keys. */
  location: string;
  /** The failing field, its value and its limit, or the failure family, when the check has one. */
  detail?: string;
}>;

export type Identity = DefinitionResolutionSnapshot["identities"][number];
export type ResolvedDefinition = DefinitionResolutionSnapshot["definitions"][number];

/** What a compiled Module contributes to the resolution of every Module that depends on it. */
export type CompiledModule = Readonly<{
  output: DefinitionCompilationOutput;
  definitions: readonly ResolvedDefinition[];
  identities: readonly Identity[];
}>;

/** The rules that compare a candidate with the releases already published, which need a database. */
export const historyDependentCodes: ReadonlySet<string> = new Set([
  "vortex.definition.prior_published_version_required",
  "vortex.definition.prior_published_version_invalid",
  "vortex.definition.publication_change_required",
  "vortex.definition.candidate_version_binding",
]);

export const syntheticVersion = "1.0.0";
export const syntheticActor = "00000000-0000-4000-8000-000000000001";

/** A stable, well-formed identifier derived from a name, standing in for a database-issued one. */
export const syntheticId = (...parts: readonly string[]): string => {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const renderLocation = (location: DefinitionValidationLocation | undefined): string =>
  location === undefined
    ? "(source)"
    : location.segments.map((segment) => `${segment.kind} ${segment.key}`).join(" > ");

export const unexpected = (
  definitionKey: string,
  stage: OfflineSourceFailure["stage"],
  error: unknown,
): OfflineSourceFailure => ({
  definitionKey,
  stage,
  code: "offline_unexpected_failure",
  location: "(source)",
  detail: describeFailure(error),
});

/**
 * Compiles one Module the way publication does, with identities derived from the source instead
 * of read from the database, and returns what it contributes together with every failure.
 */
const compileModule = (
  source: ModuleSourceDocument,
  compiled: ReadonlyMap<string, CompiledModule>,
  permissions: PlatformPermissionSource,
): { module?: CompiledModule; failures: OfflineSourceFailure[] } => {
  const dependencies = moduleDependencies(source).flatMap((entry) => {
    const dependency = compiled.get(entry.module);
    return dependency === undefined ? [] : [dependency];
  });
  const dependencyOutputs = dependencies.map((dependency) => dependency.output);
  const own = extractModuleSourceIdentityRequirements(source).flatMap((requirement) =>
    requirement.aliases.map((alias): Identity => ({
      definitionKey: requirement.definitionKey,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier: syntheticId(
        requirement.definitionKey,
        requirement.scope,
        requirement.kind,
        requirement.componentOwner,
      ) as Identity["identifier"],
    })),
  );
  const ownDefinition: ResolvedDefinition = {
    kind: "module",
    key: source.key,
    rootId: syntheticId(source.key, "root") as never,
    exactVersion: syntheticVersion,
  };
  const definitions = [
    ownDefinition,
    ...new Map(
      dependencies.flatMap((dependency) => dependency.definitions).map((d) => [d.key, d]),
    ).values(),
  ].sort((left, right) => compareCanonicalStrings(left.key, right.key));
  // A Module reached through several dependants contributes its identities once.
  const identities = [
    ...new Map(
      [...own, ...dependencies.flatMap((dependency) => dependency.identities)].map((identity) => [
        JSON.stringify([identity.definitionKey, identity.scope, identity.kind, identity.alias]),
        identity,
      ]),
    ).values(),
  ];
  const evidence = { contractVersion: "3.0.0" as const, definitions, identities };
  const parsedRequest = moduleCompilationRequestSchema.safeParse({
    sourceContractVersion: "3.0.0",
    validationContractVersion: "3.0.0",
    source,
    resolution: { ...evidence, fingerprint: fingerprintCanonicalValue(evidence) },
    draftMetadata: {
      organizationId: syntheticId("organisation"),
      draftRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: syntheticActor,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: syntheticActor,
    },
    savedConditionRevisions: [
      ...new Set(
        own
          .filter((identity) => identity.kind === "sharing_condition")
          .map((identity) => identity.identifier),
      ),
    ].map((conditionId) => ({ conditionId, revision: 1 })),
  });
  if (!parsedRequest.success)
    return { failures: [unexpected(source.key, "compile", parsedRequest.error)] };
  const request = parsedRequest.data;
  let output: DefinitionCompilationOutput;
  try {
    output = definitionCompilationOutputSchema.parse(
      compileParsedDefinition(request, dependencyOutputs, permissions),
    );
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      return {
        failures: [
          {
            definitionKey: source.key,
            stage: "compile",
            code: error.ruleCode,
            location: renderLocation(error.location),
            detail: error.family,
          },
        ],
      };
    return { failures: [unexpected(source.key, "compile", error)] };
  }
  if (output.kind !== "module")
    return { failures: [unexpected(source.key, "compile", new TypeError(output.kind))] };
  const validation = validateDefinitionSet({
    permissions,
    requests: [request],
    outputs: [output],
    dependencyOutputs,
    publishedHistories: [],
  });
  return {
    module: { output, definitions, identities },
    failures: validation.failures
      .filter((failure) => !historyDependentCodes.has(failure.ruleCode))
      .map((failure) => ({
        definitionKey: source.key,
        stage: "validation" as const,
        code: failure.ruleCode,
        location: renderLocation(failure.location),
        detail: failure.family,
      })),
  };
};

/**
 * Runs the publication checks that need no database over shipped Module sources and reports every
 * failure, not the first: the source schema, the lowering of every BeforeSave flow, the Module
 * compile and the publish-stage definition rules. The compiled Modules are returned so Applications
 * that bind them compile against the same outputs.
 */
export const compileModulesOffline = (
  sources: readonly StoredDefinitionSource[],
  permissions: PlatformPermissionSource,
): { failures: OfflineSourceFailure[]; compiled: ReadonlyMap<string, CompiledModule> } => {
  const failures: OfflineSourceFailure[] = [];
  const modules = new Map<string, ModuleSourceDocument>();
  for (const source of sources) {
    if (source.kind !== "module") continue;
    const parsed = moduleSourceDocumentSchema.safeParse(source);
    if (!parsed.success) {
      failures.push(unexpected(source.key, "source_schema", parsed.error));
      continue;
    }
    modules.set(source.key, parsed.data);
  }
  const compiled = new Map<string, CompiledModule>();
  const started = new Set<string>();
  const visit = (key: string): void => {
    const source = modules.get(key);
    if (source === undefined || started.has(key)) return;
    started.add(key);
    const declared = moduleDependencies(source);
    for (const dependency of declared) visit(dependency.module);
    const missing = declared.filter((entry) => !compiled.has(entry.module));
    if (missing.length > 0) {
      failures.push({
        definitionKey: key,
        stage: "compile",
        code: "offline_dependency_not_compiled",
        location: "(source)",
        detail: `depends on ${missing.map((entry) => entry.module).join(", ")}, which failed above`,
      });
      return;
    }
    try {
      const result = compileModule(source, compiled, permissions);
      failures.push(...result.failures);
      if (result.module !== undefined) compiled.set(key, result.module);
    } catch (error) {
      failures.push(unexpected(key, "compile", error));
    }
  };
  for (const key of [...modules.keys()].sort(compareCanonicalStrings)) visit(key);
  return { failures, compiled };
};
