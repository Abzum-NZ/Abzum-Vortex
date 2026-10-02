import "server-only";

import {
  namespacedKeySchema,
  organizationAccessDeclarationSchema,
  organizationSelectionCandidateSchema,
  type IdentityAuthority,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestResult,
  type OrganizationAccessOperationResult,
} from "@vortex/access";
import { createDefaultIdentitySessionService, createIdentityVerifier } from "@vortex/identity";
import type { RequestDatabaseTransaction } from "@vortex/db";

type HumanInterfaceCallerMode = "read" | "change";

export type HumanInterfaceCallerRequest = Readonly<{
  accessToken: string;
  selection: OrganizationSelectionCandidate;
}>;

export type HumanInterfaceCallerIdentity = Readonly<{
  kind: "human";
  identityAuthorityId: IdentityAuthority["authorityId"];
  identityId: IdentitySession["identityId"];
  sessionId: IdentitySession["sessionId"];
  authenticationStrength: IdentitySession["authenticationStrength"];
  accessTokenIssuedAt: IdentitySession["accessTokenIssuedAt"];
  accessTokenExpiresAt: IdentitySession["accessTokenExpiresAt"];
  primaryAuthenticatedAt?: IdentitySession["primaryAuthenticatedAt"];
  multiFactorAuthenticatedAt?: IdentitySession["multiFactorAuthenticatedAt"];
}>;

/** Transaction-private input for a trusted, fixed owning-service callback. */
export type HumanInterfaceOperationContext = Readonly<{
  purpose: string;
  human: HumanInterfaceCallerIdentity;
  scope: SelectedOrganizationScope;
  transaction: RequestDatabaseTransaction;
}>;

/**
 * Eligibility only narrows account authority; the owning service checks its target and returns
 * its viewer-safe projection.
 */
export type HumanInterfaceViewerSafeOperation<Value> = (
  context: HumanInterfaceOperationContext,
) => Promise<Value>;

export type HumanInterfaceCallerConfiguration<Value> = Readonly<{
  identityAuthority: IdentityAuthority;
  publishableKey: string;
  purpose: string;
  declaration: OrganizationAccessDeclaration;
  mode: HumanInterfaceCallerMode;
  operation: HumanInterfaceViewerSafeOperation<Value>;
}>;

export type HumanInterfaceCallerResult<Value> = HumanOrganizationRequestResult<
  OrganizationAccessOperationResult<Value>
>;

type ClosedRecord = Readonly<Record<string, unknown>>;

const readClosedRecord = (
  candidate: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): ClosedRecord | undefined => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return undefined;

  try {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const keys = Reflect.ownKeys(candidate);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    )
      return undefined;

    const values: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return undefined;
  }
};

const parseRequest = (candidate: unknown): HumanInterfaceCallerRequest | undefined => {
  const request = readClosedRecord(
    candidate,
    ["accessToken", "selection"],
    ["accessToken", "selection"],
  );
  if (request === undefined || typeof request.accessToken !== "string") return undefined;
  if (request.accessToken.trim().length === 0) return undefined;

  const selection = readClosedRecord(
    request.selection,
    ["organizationId", "applicationRootId"],
    ["organizationId"],
  );
  if (selection === undefined) return undefined;

  const parsedSelection = organizationSelectionCandidateSchema.safeParse(selection);
  if (!parsedSelection.success) return undefined;
  return { accessToken: request.accessToken, selection: parsedSelection.data };
};

const freezeTree = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  return Object.freeze(value) as Value;
};

export const createHumanInterfaceCallerService = <Value>(
  configuration: HumanInterfaceCallerConfiguration<Value>,
) => {
  let snapshot: HumanInterfaceCallerConfiguration<Value>;
  try {
    snapshot = {
      identityAuthority: configuration.identityAuthority,
      publishableKey: configuration.publishableKey,
      purpose: configuration.purpose,
      declaration: configuration.declaration,
      mode: configuration.mode,
      operation: configuration.operation,
    };
  } catch {
    throw new Error("Invalid human Interface caller configuration");
  }

  if (snapshot.mode !== "read" && snapshot.mode !== "change")
    throw new Error("Invalid human Interface caller configuration");
  if (typeof snapshot.operation !== "function")
    throw new Error("Invalid human Interface caller configuration");

  let verifier: ReturnType<typeof createIdentityVerifier>;
  let purpose: string;
  let declaration: OrganizationAccessDeclaration;
  try {
    verifier = createIdentityVerifier(snapshot.identityAuthority, snapshot.publishableKey);
    purpose = namespacedKeySchema.parse(snapshot.purpose);
    declaration = freezeTree(organizationAccessDeclarationSchema.parse(snapshot.declaration));
  } catch {
    throw new Error("Invalid human Interface caller configuration");
  }

  const identitySessions = createDefaultIdentitySessionService(verifier);
  const organizationRequests = createHumanOrganizationRequestService({
    identityAuthorityId: verifier.authority.authorityId,
    channel: "programmatic_interface",
  });
  const fixedMode = snapshot.mode;
  const fixedOperation = snapshot.operation;

  return Object.freeze({
    async run(candidate: unknown): Promise<HumanInterfaceCallerResult<Value>> {
      const request = parseRequest(candidate);
      if (request === undefined) return { kind: "unavailable" };

      let resolution: Awaited<ReturnType<typeof identitySessions.resolve>>;
      try {
        resolution = await identitySessions.resolve(request.accessToken);
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      if (resolution.kind === "temporarily_unavailable")
        return { kind: "temporarily_unavailable" };
      if (resolution.kind !== "active") return { kind: "unavailable" };

      const session = resolution.session;
      const human: HumanInterfaceCallerIdentity = Object.freeze({
        kind: "human",
        identityAuthorityId: verifier.authority.authorityId,
        identityId: session.identityId,
        sessionId: session.sessionId,
        authenticationStrength: session.authenticationStrength,
        accessTokenIssuedAt: session.accessTokenIssuedAt,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        ...(session.primaryAuthenticatedAt === undefined
          ? {}
          : { primaryAuthenticatedAt: session.primaryAuthenticatedAt }),
        ...(session.multiFactorAuthenticatedAt === undefined
          ? {}
          : { multiFactorAuthenticatedAt: session.multiFactorAuthenticatedAt }),
      });

      const invoke = async (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
      ): Promise<OrganizationAccessOperationResult<Value>> =>
        runOrganizationAccessOperation(transaction, scope, declaration, async () =>
          fixedOperation(
            Object.freeze({
              purpose,
              human,
              scope: freezeTree(scope),
              transaction,
            }),
          ),
        );

      try {
        return fixedMode === "read"
          ? await organizationRequests.run(session, request.selection, invoke)
          : await organizationRequests.runChange(session, request.selection, invoke);
      } catch {
        return { kind: "temporarily_unavailable" };
      }
    },
  });
};
