import type { definitionCompilationRequestSchema } from "../../schema";
import {
  connectionTypeSchema,
  definitionCompilationOutputSchema,
  type DefinitionCompilationOutput,
} from "../../schema";
import { fingerprintCanonicalValue } from "../canonical-json-definition";
import { DefinitionCompilationError } from "../compilation-error";
import { dependencyOrder, resolvedDependencies } from "./dependencies";
import { provenanceFor } from "./provenance";
import { Resolution } from "./resolution";
import { asObject, compilerRootLocation, fail, type JsonObject } from "./shared";

function compileConnection(source: JsonObject, resolution: Resolution) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "connection_type");
  const authentication = asObject(body.authentication);
  const compiledAuthentication =
    authentication.kind === "oauth2"
      ? {
          kind: "oauth2",
          secretFieldKeys: authentication.secret_fields,
          scopes: authentication.scopes,
        }
      : authentication.kind === "signed_secret"
        ? {
            kind: "signed_secret",
            secretFieldKeys: authentication.secret_fields,
            algorithm: authentication.algorithm,
          }
        : {
            kind: "api_key",
            secretFieldKeys: authentication.secret_fields,
            placement: authentication.placement,
          };
  return connectionTypeSchema.parse({
    connectionTypeId: root.rootId,
    key: definitionKey,
    version: root.exactVersion,
    name: body.name,
    purpose: body.purpose,
    provider: body.provider,
    authentication: compiledAuthentication,
    allowedHosts: body.allowed_hosts,
    allowRedirects: body.allow_redirects,
    shapes: (body.shapes as JsonObject[]).map((shape) => ({
      key: shape.key,
      fields: shape.fields,
    })),
    operations: (body.operations as JsonObject[]).map((operation) => ({
      key: operation.key,
      method: operation.method,
      pathTemplate: operation.path,
      inputShapeKey: operation.input,
      outputShapeKey: operation.output,
      timeoutSeconds: operation.timeout_seconds,
      maximumAttempts: operation.max_attempts,
      maximumResponseBytes: operation.maximum_response_bytes,
    })),
    incomingMessages: (body.incoming_messages as JsonObject[]).map((message) => ({
      key: message.key,
      signature: message.signature,
      replayWindowSeconds: message.replay_window_seconds,
      inputShapeKey: message.input,
      workflowTriggerKey: message.workflow_trigger,
    })),
    ...(body.health_operation ? { healthOperationKey: body.health_operation } : {}),
    ...(body.revocation_operation ? { revocationOperationKey: body.revocation_operation } : {}),
  });
}

export function compileParsedConnectionRequest(
  request: ParsedConnectionRequest,
): DefinitionCompilationOutput {
  const sourceDocument = request.source;
  const source = sourceDocument as unknown as JsonObject;
  try {
    const resolution = new Resolution(request.resolution, source);
    const canonical: unknown = compileConnection(source, resolution);
    const ownDefinition = resolution.definition(sourceDocument.key, sourceDocument.kind);
    const artifact = {
      kind: sourceDocument.kind,
      definitionKey: sourceDocument.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(asObject(canonical)),
      resolutionFingerprint: request.resolution.fingerprint,
    };
    const output = definitionCompilationOutputSchema.safeParse({
      kind: sourceDocument.kind,
      canonical,
      artifact,
      provenance: provenanceFor(source, canonical, resolution),
      dependencyOrder: dependencyOrder(source),
      resolvedDependencies: resolvedDependencies(source, resolution),
      resolutionFingerprint: request.resolution.fingerprint,
    });
    if (!output.success) fail("vortex.definition.invalid_compilation_output", "invalid_value");
    return output.data;
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      throw error.location
        ? error
        : new DefinitionCompilationError(
            error.ruleCode,
            error.family,
            compilerRootLocation(source),
          );
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}

/** Requests as this package's own schemas return them, carrying the ids compiling needs. */
export type ParsedConnectionRequest = ReturnType<typeof definitionCompilationRequestSchema.parse>;
