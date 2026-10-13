import {
  type DefinitionRuleFailure,
  walkDefinitionContract,
  jsonValueSchema,
  builderKeySchema,
  namespacedKeySchema,
} from "../../schema";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import type { z } from "zod";
import {
  type DefinitionSetValidationContext,
  allValidationOutputs,
  type PreparedValidationContext,
  editSaveSources,
  type JsonObject,
  parseEditSaveSource,
} from "./context";
import { object, outputKey, failure, rootLocation } from "./helpers";
import {
  sourceTranslationContext,
  sourceValueAtPath,
  unlistedBlockPath,
  issueLocation,
} from "./source-paths";

export function artifactBindingRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of allValidationOutputs(context)) {
    const canonical = object(output.canonical);
    const envelope = object(canonical.envelope ?? canonical);
    const expectedContent = output.kind === "connection_type" ? canonical : canonical.content;
    const request = context.requests.find(
      (candidate) => candidate.source.key === outputKey(output),
    );
    const resolved = request?.resolution.definitions.find(
      (candidate) => candidate.kind === output.kind && candidate.key === outputKey(output),
    );
    if (
      output.artifact.kind !== output.kind ||
      output.artifact.definitionKey !== outputKey(output) ||
      output.artifact.rootId !== String(envelope.rootId ?? envelope.connectionTypeId) ||
      output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
      output.artifact.contentFingerprint !== fingerprintCanonicalValue(expectedContent) ||
      (output.kind === "connection_type" && canonical.version !== output.artifact.exactVersion) ||
      (resolved !== undefined &&
        (output.artifact.rootId !== resolved.rootId ||
          output.artifact.exactVersion !== resolved.exactVersion ||
          output.artifact.resolutionFingerprint !== request?.resolution.fingerprint))
    )
      failures.push(failure(output, "vortex.definition.artifact_binding", "incompatible_version"));
  }
  return failures;
}

export function localIdentityRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  const values = editSaveSources(context);
  for (const [index, source] of values.entries()) {
    const sourceKey =
      source !== null && typeof source === "object" && !Array.isArray(source)
        ? (source as JsonObject).key
        : undefined;
    const output =
      context.outputs.find((candidate) => {
        const canonical = object(candidate.canonical);
        return String(object(canonical.envelope ?? canonical).key) === sourceKey;
      }) ?? context.outputs[index];
    let duplicateKey: string | undefined;
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    if (!parsed.success) continue;
    walkDefinitionContract(parsed.schema, parsed.data, (schema, value) => {
      if (schema === jsonValueSchema) return;
      const definition = (schema as z.core.$ZodTypes)._zod.def;
      // A table row is user data, not a declaration: columns named id/key may repeat.
      if (
        Array.isArray(value) &&
        definition.type === "array" &&
        definition.element._zod.def.type !== "record"
      ) {
        for (const property of ["id", "key"] as const) {
          const values = value
            .filter(
              (entry): entry is JsonObject =>
                entry !== null && typeof entry === "object" && !Array.isArray(entry),
            )
            .map((entry) => entry[property])
            .filter((entry): entry is string => typeof entry === "string");
          const seen = new Set<string>();
          for (const key of values) {
            if (seen.has(key)) duplicateKey ??= key;
            seen.add(key);
          }
        }
      }
    });
    if (duplicateKey !== undefined) {
      const translation = sourceTranslationContext(source);
      const location =
        translation &&
        (builderKeySchema.safeParse(duplicateKey).success ||
          namespacedKeySchema.safeParse(duplicateKey).success)
          ? {
              ...translation.rootLocation,
              segments: [
                ...translation.rootLocation.segments,
                { kind: "setting" as const, key: duplicateKey },
              ],
            }
          : translation?.rootLocation;
      failures.push({
        ruleCode: "vortex.definition.local_identity_unique",
        family: "duplicate_key",
        ...((location ?? (output ? rootLocation(output) : undefined))
          ? { location: location ?? rootLocation(output!) }
          : {}),
      });
    }
  }
  return failures;
}

export function sourceShapeRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((source, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    if (parsed.success) return [];
    const translation = sourceTranslationContext(source);
    return parsed.error.issues.map((issue): DefinitionRuleFailure => {
      const path = issue.path.filter((part): part is string | number => typeof part !== "symbol");
      const family: DefinitionRuleFailure["family"] =
        issue.code === "unrecognized_keys"
          ? "unknown_property"
          : issue.code === "invalid_value"
            ? "unsupported_choice"
            : issue.code === "too_small" && (issue.origin === "array" || issue.origin === "set")
              ? "too_few_items"
              : issue.code === "too_big" && (issue.origin === "array" || issue.origin === "set")
                ? "too_many_items"
                : issue.code === "invalid_type" && sourceValueAtPath(source, path) === undefined
                  ? "required_value"
                  : "invalid_value";
      const effectivePath =
        path.at(-1) === "platform_block_dependencies" ? (unlistedBlockPath(source) ?? path) : path;
      return {
        ruleCode: "vortex.definition.source_shape",
        family,
        ...(translation ? { location: issueLocation(translation, effectivePath) } : {}),
      };
    });
  });
}

export function pinnedModulePermissionIdRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((candidate): DefinitionRuleFailure[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const source = object(candidate);
    if (source.kind !== "module") return [];
    if (source.body === null || typeof source.body !== "object" || Array.isArray(source.body))
      return [];
    const body = object(source.body);
    if (!Array.isArray(body.permissions)) return [];
    const pinnedPermissions = (body.permissions as unknown[]).filter(
      (candidatePermission) =>
        candidatePermission !== null &&
        typeof candidatePermission === "object" &&
        !Array.isArray(candidatePermission) &&
        Object.prototype.hasOwnProperty.call(candidatePermission, "pinnedPermissionId"),
    );
    if (pinnedPermissions.length === 0) return [];
    return [
      {
        ruleCode: "vortex.definition.source_shape",
        family: "unsupported_choice",
        location: {
          documentKind: "module",
          documentKey: String(source.key),
          segments: [{ kind: "module", key: String(source.key) }],
        },
      },
    ];
  });
}
