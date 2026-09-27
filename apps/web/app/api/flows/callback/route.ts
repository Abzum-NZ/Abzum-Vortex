import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  createDurableActorRequestService,
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
  type DurableActorRequestScope,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import { createProtectedOperationExecutor } from "@vortex/app";
import { type RequestDatabaseTransaction, type RuntimeDatabaseTransaction } from "@vortex/db";
import { createTenantGovernanceService } from "@vortex/identity";
import {
  applicationRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  tenantIdSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type TenantId,
} from "@vortex/contracts";
import {
  applicationKestraBaseUrlEnvironmentKey,
  applicationKestraCallbackKeySecretName,
  createDatabaseProtectedNodeRunStore,
  createDatabaseProtectedNodeEffectLedger,
  createProtectedNodeExecution,
  resolveApplicationKestraInstanceTarget,
  type ProtectedNodeRunRecord,
} from "@vortex/workflow";
import { getIdentityAuthorityConfiguration } from "../../../auth/_lib/authority-configuration";
import { privateJsonResponse } from "../../../_lib/private-response";
import { optionalEnvironmentValue } from "../../../_lib/server-configuration";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequestsFor,
} from "../../../_lib/server-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;

const readBoundedBody = async (request: NextRequest): Promise<string | undefined> => {
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumRequestBodyLength) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const kestraExecutionState = async (
  binding: ProtectedNodeRunRecord["kestra"],
): Promise<unknown> => {
  const target = resolveApplicationKestraInstanceTarget({
    [applicationKestraBaseUrlEnvironmentKey]: optionalEnvironmentValue(applicationKestraBaseUrlEnvironmentKey),
  });
  const baseUrl = target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`;
  const path = [
    "api/v1/executions",
    encodeURIComponent(binding.namespace),
    encodeURIComponent(binding.flowId),
    encodeURIComponent(binding.executionId),
  ].join("/");
  const url = new URL(path, baseUrl);
  url.searchParams.set("tenant", binding.tenant);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("KESTRA_STATUS_UNAVAILABLE");
  return response.json();
};

const createCallbackService = () => {
  const { authorityId: identityAuthorityId } = getIdentityAuthorityConfiguration();
  const createServices = (
    resolvedRequestTransaction?: HumanOrganizationRequestDependencies["resolvedRequestTransaction"],
  ) => {
    const requestDependencies = {
      ...humanOrganizationRequestDependencies(identityAuthorityId),
      channel: "durable_workflow",
      ...(resolvedRequestTransaction === undefined ? {} : { resolvedRequestTransaction }),
    } as const;
    const durableRequests = humanOrganizationRequestsFor(requestDependencies);
    return {
      accessAdministration: createOrganizationAccessAdministrationService(requestDependencies),
      runtimeSettings: createOrganizationRuntimeSettingsAdministrationService(requestDependencies),
      tenantGovernance: {
        run: <Result>(
          session: IdentitySession,
          selection: OrganizationSelectionCandidate,
          operation: (scope: Readonly<{
            tenantId: TenantId;
            operations: ReturnType<typeof createTenantGovernanceService>;
          }>) => Promise<Result>,
        ) =>
          durableRequests.runChange(session, selection, (transaction, scope) =>
            operation({
              tenantId: scope.tenantId,
              operations: createTenantGovernanceService({
                runtimeTransaction: <Value>(
                  run: (transaction: RuntimeDatabaseTransaction) => Promise<Value>,
                ) => run(transaction),
              }),
            }),
          ),
      },
    };
  };
  const services = createServices();
  const executor = createProtectedOperationExecutor({
    ...services,
    durableOperations: (transaction: RequestDatabaseTransaction, scope: DurableActorRequestScope) => {
      if (scope.actor.kind !== "organization_account")
        throw new Error("DURABLE_OPERATION_ACTOR_UNAVAILABLE");
      const selectedScope: SelectedOrganizationScope = {
        tenantId: tenantIdSchema.parse(scope.tenantId),
        organizationId: organizationIdSchema.parse(scope.organizationId),
        organizationAccountId: organizationAccountIdSchema.parse(scope.actor.organizationAccountId),
        applicationRootId: applicationRootIdSchema.parse(scope.applicationRootId),
        accessVersion: scope.accessVersion,
      };
      // The durable actor resolver established this exact request context on this transaction.
      // Service wrappers reuse it so the operation and effect record commit together.
      const resolvedRequestTransaction: NonNullable<HumanOrganizationRequestDependencies["resolvedRequestTransaction"]> =
        async <ResolvedScope, Result>(_resolve: unknown, operation: (
          transaction: RequestDatabaseTransaction,
          scope: ResolvedScope,
        ) => Promise<Result>): Promise<Result> =>
          operation(transaction, selectedScope as unknown as ResolvedScope);
      return createServices(resolvedRequestTransaction);
    },
    durableActorRequest: createDurableActorRequestService({ identityAuthorityId }),
  });
  const runs = createDatabaseProtectedNodeRunStore();
  const execution = createProtectedNodeExecution({
    callbackKey: () => {
      const secret = optionalEnvironmentValue(applicationKestraCallbackKeySecretName);
      return secret === undefined ? undefined : Buffer.from(secret, "utf8");
    },
    correlationId: randomUUID,
    runs,
    effects: createDatabaseProtectedNodeEffectLedger(),
    operations: executor,
    readKestraState: kestraExecutionState,
  });
  return execution;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (
      declaredLength > maximumRequestBodyLength ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    )
      return privateJsonResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      }, 200);
    const text = await readBoundedBody(request);
    if (text === undefined)
      return privateJsonResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      }, 200);
    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch {
      return privateJsonResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      }, 200);
    }
    return privateJsonResponse(await createCallbackService().execute(candidate), 200);
  } catch {
    return privateJsonResponse({
      outcome: "retryable_failure",
      safeCode: "callback_unavailable",
      nextPollAt: new Date(Date.now() + 1_000).toISOString(),
    }, 200);
  }
}
