import type {
  ApplicationCompilationOutput,
  ApplicationCompilationRequest,
  ModuleCompilationOutput,
  ModuleCompilationRequest,
  DefinitionCompilationRequest,
  DefinitionCompilationOutput,
} from "./definition-compilation-contracts";
import {
  compileParsedApplicationRequest,
  type ParsedApplicationRequest,
} from "./compiler/application";
import {
  compileParsedConnectionRequest,
  type ParsedConnectionRequest,
} from "./compiler/connection";
import { assertDependencyOutputLimits } from "./compiler/dependencies";
import { compileParsedModuleRequest, type ParsedModuleRequest } from "./compiler/module";
import type { JsonObject } from "./compiler/shared";
import type { PlatformPermissionSource } from "../access/platform-permissions";

const explicitCompilationKind = (input: unknown): "module" | "application" | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const request = input as JsonObject;
  if (!("sourceContractVersion" in request) && !("validationContractVersion" in request))
    return undefined;
  if (
    request.source === null ||
    typeof request.source !== "object" ||
    Array.isArray(request.source)
  )
    return undefined;
  const kind = (request.source as JsonObject).kind;
  return kind === "module" || kind === "application" ? kind : undefined;
};

/** The request shapes the compile entry points dispatch on, as they declare them. */
type DispatchableCompilationRequest =
  DefinitionCompilationRequest | ApplicationCompilationRequest | ModuleCompilationRequest;

/**
 * Package-internal compile entry for a request this package parsed and dependency outputs it
 * parsed or produced, so neither is parsed a second time. index.ts and compiler-api.ts do not
 * re-export it: callers outside this package go through the publication service.
 */
export function compileParsedDefinition(
  request: ApplicationCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  permissions: PlatformPermissionSource,
): ApplicationCompilationOutput;
export function compileParsedDefinition(
  request: ModuleCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  permissions: PlatformPermissionSource,
): ModuleCompilationOutput;
export function compileParsedDefinition(
  request: DefinitionCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  permissions: PlatformPermissionSource,
): DefinitionCompilationOutput;
export function compileParsedDefinition(
  request: DispatchableCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  permissions: PlatformPermissionSource,
): DefinitionCompilationOutput {
  assertDependencyOutputLimits(dependencyOutputs);
  const explicitKind = explicitCompilationKind(request);
  if (explicitKind === "module")
    return compileParsedModuleRequest(request as ParsedModuleRequest, dependencyOutputs);
  if (explicitKind === "application")
    return compileParsedApplicationRequest(
      request as ParsedApplicationRequest,
      dependencyOutputs,
      permissions,
    );
  return compileParsedConnectionRequest(request as ParsedConnectionRequest);
}
