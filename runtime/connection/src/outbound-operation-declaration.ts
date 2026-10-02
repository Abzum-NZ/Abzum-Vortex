import "server-only";

import {
  applicationConnectionBindingSchema,
  builderKeySchema,
  connectionOperationSchema,
  connectionShapeSchema,
  exactDefinitionDependencySchema,
  isRecord,
  PLATFORM_CONNECTION_TYPE_RELEASES,
  sameId,
  type ApplicationConnectionBinding,
  type ConnectionOperation,
  type ConnectionType,
  type ExactDefinitionDependency,
} from "@vortex/contracts";

type ConnectionTypeDependency = Extract<ExactDefinitionDependency, { kind: "connection_type" }>;

type DeepReadonly<Value> = Value extends readonly unknown[]
  ? readonly DeepReadonly<Value[number]>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type OutboundOperationShape = ConnectionType["shapes"][number];

export type ResolveOutboundOperationDeclarationInput = Readonly<{
  binding: ApplicationConnectionBinding;
  dependency: ConnectionTypeDependency;
  operationKey: string;
}>;

export type OutboundOperationDeclaration = Readonly<{
  bindingId: ApplicationConnectionBinding["bindingId"];
  connectionTypeId: ConnectionTypeDependency["rootId"];
  connectionTypeVersion: ConnectionTypeDependency["releaseVersion"];
  contentFingerprint: ConnectionTypeDependency["contentFingerprint"];
  catalogueFingerprint: ConnectionTypeDependency["catalogueFingerprint"];
  provider: string;
  operation: DeepReadonly<ConnectionOperation>;
  inputShape: DeepReadonly<OutboundOperationShape>;
  outputShape: DeepReadonly<OutboundOperationShape>;
  allowedHosts: readonly string[];
  allowRedirects: boolean;
}>;

export type OutboundOperationDeclarationResult =
  | Readonly<{ outcome: "available"; declaration: OutboundOperationDeclaration }>
  | Readonly<{
      outcome: "refused";
      reasonCode: "outbound_operation_unavailable";
    }>;

const maximumOwnedOperationCount = PLATFORM_CONNECTION_TYPE_RELEASES.reduce(
  (maximum, release) => Math.max(maximum, release.source.body.operations.length),
  0,
);

const refused: OutboundOperationDeclarationResult = Object.freeze({
  outcome: "refused",
  reasonCode: "outbound_operation_unavailable",
});

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

const hasBoundedRequiredOperations = (input: unknown): input is Record<string, unknown> => {
  if (!isRecord(input) || !isRecord(input.binding)) return false;
  const requiredOperationKeys = input.binding.requiredOperationKeys;
  if (
    !Array.isArray(requiredOperationKeys) ||
    requiredOperationKeys.length < 1 ||
    requiredOperationKeys.length > maximumOwnedOperationCount
  ) {
    return false;
  }

  const validatedKeys: string[] = [];
  for (const key of requiredOperationKeys) {
    const parsedKey = builderKeySchema.safeParse(key);
    if (!parsedKey.success) return false;
    validatedKeys.push(parsedKey.data);
  }
  return new Set(validatedKeys).size === validatedKeys.length;
};

const hasClosedInputKeys = (input: Record<string, unknown>): boolean => {
  const keys = Reflect.ownKeys(input);
  return (
    keys.length === 3 &&
    keys.every(
      (key) =>
        key === "binding" || key === "dependency" || key === "operationKey",
    )
  );
};

const findExactlyOne = <Value>(values: readonly Value[], matches: (value: Value) => boolean) => {
  const found: Value[] = [];
  for (const value of values) {
    if (matches(value)) found.push(value);
    if (found.length > 1) return undefined;
  }
  return found.length === 1 ? found[0] : undefined;
};

const parseShape = (
  release: (typeof PLATFORM_CONNECTION_TYPE_RELEASES)[number],
  key: string,
): OutboundOperationShape | undefined => {
  const authoredShape = findExactlyOne(release.source.body.shapes, (shape) => shape.key === key);
  if (authoredShape === undefined) return undefined;
  const parsedShape = connectionShapeSchema.safeParse({
    key: authoredShape.key,
    fields: authoredShape.fields,
  });
  return parsedShape.success ? parsedShape.data : undefined;
};

/**
 * Resolves a declaration from one exact published binding/dependency pair and
 * the platform-owned immutable connection catalogue. The caller must select
 * both descriptors from the same authentic exact Application consumer-read
 * result retained for the run. Availability grants no permission and does not
 * indicate that an external call was attempted.
 */
export const resolveOutboundOperationDeclaration = (
  input: ResolveOutboundOperationDeclarationInput,
): OutboundOperationDeclarationResult => {
  try {
    const candidate: unknown = input;
    if (
      !hasBoundedRequiredOperations(candidate) ||
      !isRecord(candidate) ||
      !hasClosedInputKeys(candidate)
    ) {
      return refused;
    }

    const parsedOperationKey = builderKeySchema.safeParse(candidate.operationKey);
    if (!parsedOperationKey.success) return refused;
    const parsedBinding = applicationConnectionBindingSchema.safeParse(candidate.binding);
    if (!parsedBinding.success) return refused;
    const parsedDependency = exactDefinitionDependencySchema.safeParse(candidate.dependency);
    if (!parsedDependency.success) return refused;

    const binding = parsedBinding.data;
    const dependency = parsedDependency.data;
    const operationKey = parsedOperationKey.data;
    if (
      dependency.kind !== "connection_type" ||
      !binding.requiredOperationKeys.includes(operationKey) ||
      !sameId(binding.connectionTypeId, dependency.rootId) ||
      binding.resolvedVersion !== dependency.releaseVersion
    ) {
      return refused;
    }

    const selectedRelease = findExactlyOne(PLATFORM_CONNECTION_TYPE_RELEASES, (release) =>
      sameId(release.rootId, dependency.rootId) &&
      release.releaseVersion === dependency.releaseVersion,
    );
    if (
      selectedRelease === undefined ||
      selectedRelease.source.key !== dependency.key ||
      selectedRelease.contentFingerprint !== dependency.contentFingerprint ||
      selectedRelease.catalogueFingerprint !== dependency.catalogueFingerprint
    ) {
      return refused;
    }

    for (const requiredOperationKey of binding.requiredOperationKeys) {
      if (
        findExactlyOne(
          selectedRelease.source.body.operations,
          (operation) => operation.key === requiredOperationKey,
        ) === undefined
      ) {
        return refused;
      }
    }

    const authoredOperation = findExactlyOne(
      selectedRelease.source.body.operations,
      (operation) => operation.key === operationKey,
    );
    if (authoredOperation === undefined) return refused;

    const parsedOperation = connectionOperationSchema.safeParse({
      key: authoredOperation.key,
      method: authoredOperation.method,
      pathTemplate: authoredOperation.path,
      inputShapeKey: authoredOperation.input,
      outputShapeKey: authoredOperation.output,
      timeoutSeconds: authoredOperation.timeout_seconds,
      maximumAttempts: authoredOperation.max_attempts,
      maximumResponseBytes: authoredOperation.maximum_response_bytes,
    });
    if (!parsedOperation.success) return refused;

    const inputShape = parseShape(selectedRelease, parsedOperation.data.inputShapeKey);
    const outputShape = parseShape(selectedRelease, parsedOperation.data.outputShapeKey);
    if (inputShape === undefined || outputShape === undefined) return refused;

    const declaration: OutboundOperationDeclaration = {
      bindingId: binding.bindingId,
      connectionTypeId: selectedRelease.rootId,
      connectionTypeVersion: selectedRelease.releaseVersion,
      contentFingerprint: selectedRelease.contentFingerprint,
      catalogueFingerprint: selectedRelease.catalogueFingerprint,
      provider: selectedRelease.source.body.provider,
      operation: parsedOperation.data,
      inputShape,
      outputShape,
      allowedHosts: [...selectedRelease.source.body.allowed_hosts],
      allowRedirects: selectedRelease.source.body.allow_redirects,
    };

    return deepFreeze<OutboundOperationDeclarationResult>({ outcome: "available", declaration });
  } catch {
    return refused;
  }
};
