import {
  applicationCompilationRequestSchema,
  definitionCompilationRequestSchema,
  moduleCompilationRequestSchema,
  type ApplicationCompilationOutput,
  type ApplicationCompilationRequest,
  type ModuleCompilationOutput,
  type ModuleCompilationRequest,
  type DefinitionCompilationRequest,
  type DefinitionCompilationOutput,
} from "../schema";
import {
  compileParsedApplicationRequest,
  type ParsedApplicationRequest,
} from "./compiler/application";
import {
  compileParsedConnectionRequest,
  type ParsedConnectionRequest,
} from "./compiler/connection";
import {
  assertDependencyOutputLimits,
  parseDefinitionCompilationContext,
} from "./compiler/dependencies";
import { compileParsedModuleRequest, type ParsedModuleRequest } from "./compiler/module";
import { fail, type JsonObject } from "./compiler/shared";

export type DefinitionCompilationContext = Readonly<{
  dependencyOutputs?: readonly DefinitionCompilationOutput[];
}>;

function compileDefinitionInternal(
  input: unknown,
  context?: DefinitionCompilationContext,
): DefinitionCompilationOutput {
  const parsed = definitionCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  // A connection type has no definition dependencies; the context is still parsed so a malformed
  // one is refused exactly as it is on the Application and Module entry points.
  parseDefinitionCompilationContext(context);
  return compileParsedConnectionRequest(parsed.data);
}

function compileApplicationInternal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ApplicationCompilationOutput {
  const parsed = applicationCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  return compileParsedApplicationRequest(parsed.data, parseDefinitionCompilationContext(context));
}

function compileModuleInternal(
  input: unknown,
  context?: DefinitionCompilationContext,
): ModuleCompilationOutput {
  const parsed = moduleCompilationRequestSchema.safeParse(input);
  if (!parsed.success) fail("vortex.definition.invalid_compilation_request", "invalid_value");
  return compileParsedModuleRequest(parsed.data, parseDefinitionCompilationContext(context));
}

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
 * re-export it: callers outside this package use compileDefinition or
 * compileDefinitionWithContext, which parse what they are given.
 */
export function compileParsedDefinition(
  request: ApplicationCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ApplicationCompilationOutput;
export function compileParsedDefinition(
  request: ModuleCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): ModuleCompilationOutput;
export function compileParsedDefinition(
  request: DefinitionCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): DefinitionCompilationOutput;
export function compileParsedDefinition(
  request: DispatchableCompilationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
): DefinitionCompilationOutput {
  assertDependencyOutputLimits(dependencyOutputs);
  const explicitKind = explicitCompilationKind(request);
  if (explicitKind === "module")
    return compileParsedModuleRequest(request as ParsedModuleRequest, dependencyOutputs);
  if (explicitKind === "application")
    return compileParsedApplicationRequest(request as ParsedApplicationRequest, dependencyOutputs);
  return compileParsedConnectionRequest(request as ParsedConnectionRequest);
}

export function compileDefinition(
  input: ApplicationCompilationRequest,
): ApplicationCompilationOutput;
export function compileDefinition(input: ModuleCompilationRequest): ModuleCompilationOutput;
export function compileDefinition(input: DefinitionCompilationRequest): DefinitionCompilationOutput;
export function compileDefinition(
  input: unknown,
): DefinitionCompilationOutput | ApplicationCompilationOutput {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleInternal(input);
  if (explicitKind === "application") return compileApplicationInternal(input);
  return compileDefinitionInternal(input);
}

export function compileDefinitionWithContext(
  input: ApplicationCompilationRequest,
  context: DefinitionCompilationContext,
): ApplicationCompilationOutput;
export function compileDefinitionWithContext(
  input: ModuleCompilationRequest,
  context: DefinitionCompilationContext,
): ModuleCompilationOutput;
export function compileDefinitionWithContext(
  input: DefinitionCompilationRequest,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput;
export function compileDefinitionWithContext(
  input: unknown,
  context: DefinitionCompilationContext,
): DefinitionCompilationOutput | ApplicationCompilationOutput {
  const explicitKind = explicitCompilationKind(input);
  if (explicitKind === "module") return compileModuleInternal(input, context);
  if (explicitKind === "application") return compileApplicationInternal(input, context);
  return compileDefinitionInternal(input, context);
}
