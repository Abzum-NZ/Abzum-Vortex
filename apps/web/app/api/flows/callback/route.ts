import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  createDurableActorRequestService,
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
} from "@vortex/access";
import {
  createAppTelemetryCollector,
  createDatabaseFlowStores,
  createOperationsAlertSink,
  createProtectedOperationExecutor,
} from "@vortex/app";
import { type RuntimeDatabaseTransaction } from "@vortex/db";
import { createTenantGovernanceService } from "@vortex/identity";
import type { IdentitySession, OrganizationSelectionCandidate, TenantId } from "@vortex/contracts";
import {
  applicationKestraCallbackKeySecretName,
  createDatabaseProtectedNodeRunStore,
  createProtectedNodeExecution,
  resolveApplicationKestraInstanceTarget,
  type ProtectedNodeRunRecord,
} from "@vortex/workflow";
import { getIdentityAuthorityConfiguration } from "../../../auth/_lib/authority-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;
const privateResponse = (body: unknown): NextResponse => {
  const response = NextResponse.json(body, { status: 200 });
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

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
  const target = resolveApplicationKestraInstanceTarget(process.env);
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
  const telemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });
  const { authorityId: identityAuthorityId } = getIdentityAuthorityConfiguration();
  const durableRequests = createHumanOrganizationRequestService({
    identityAuthorityId,
    telemetry,
    channel: "durable_workflow",
  });
  const services = {
    accessAdministration: createOrganizationAccessAdministrationService({
      identityAuthorityId,
      telemetry,
      channel: "durable_workflow",
    }),
    runtimeSettings: createOrganizationRuntimeSettingsAdministrationService({
      identityAuthorityId,
      telemetry,
      channel: "durable_workflow",
    }),
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
              runtimeTransaction: <Result>(
                run: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
              ) => run(transaction),
            }),
          }),
        ),
    },
  };
  const executor = createProtectedOperationExecutor({
    ...services,
    durableOperations: services,
    durableActorRequest: createDurableActorRequestService({ identityAuthorityId }),
  });
  const stores = createDatabaseFlowStores();
  const runs = createDatabaseProtectedNodeRunStore();
  const execution = createProtectedNodeExecution({
    callbackKey: () => {
      const secret = process.env[applicationKestraCallbackKeySecretName];
      return secret === undefined ? undefined : Buffer.from(secret, "utf8");
    },
    correlationId: randomUUID,
    runs,
    effects: stores.ledger,
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
      return privateResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      });
    const text = await readBoundedBody(request);
    if (text === undefined)
      return privateResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      });
    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch {
      return privateResponse({
        outcome: "permanent_refusal",
        safeCode: "callback_refused",
      });
    }
    return privateResponse(await createCallbackService().execute(candidate));
  } catch {
    return privateResponse({
      outcome: "retryable_failure",
      safeCode: "callback_unavailable",
      nextPollAt: new Date(Date.now() + 1_000).toISOString(),
    });
  }
}
