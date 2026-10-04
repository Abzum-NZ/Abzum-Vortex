import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createBuilderAuthority } from "@vortex/access";
import {
  createFlowTestRunner,
  createPreviewInstallationCoordinator,
  PreviewInstallationCoordinatorError,
} from "@vortex/app";
import {
  builderPreviewCreateRequestSchema,
  builderPreviewCreateResultSchema,
  builderPreviewDiscardRequestSchema,
  builderPreviewDiscardResultSchema,
  builderPreviewOperationRefusalSchema,
  builderPreviewReadRequestSchema,
  builderPreviewReadResultSchema,
  builderPreviewRunFlowRequestSchema,
  builderPreviewRunFlowResultSchema,
  builderPreviewSaveRecordRequestSchema,
  builderPreviewSaveRecordResultSchema,
  flowTestRunResponseSchema,
  identitySessionSchema,
  moduleDefinitionConsumerReadResultV3Schema,
  moduleRootIdSchema,
  organizationSelectionCandidateSchema,
  revisionSchema,
  saveRecordCommandV2Schema,
  saveRecordResultV2Schema,
  sessionContextSchema,
  type ApplicationRootId,
  type BuilderPreviewOperationLocation,
  type BuilderPreviewOperationRefusal,
  type IdentitySession,
  type OrganizationId,
  type SelectedOrganizationScope,
  type SessionContext,
} from "@vortex/contracts";
import {
  createDatabaseDefinitionPublicationRepository,
  createDatabaseDefinitionPublicationService,
} from "@vortex/definition";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { createPreviewRecordPort } from "@vortex/record";
import { z } from "zod";
import { getIdentityAuthorityConfiguration, getIdentityJourneyConfiguration } from "../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { readBoundedRequestText } from "../api/_lib/bounded-request-body";
import { privateJsonResponse } from "./private-response";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { appTelemetry, humanOrganizationRequests } from "./server-composition";

const maximumRequestBodyLength = 131_072;
type RootClassificationRow = DatabaseRow & {
  readonly outcome: unknown;
  readonly application_origin_kind: unknown;
};
type HumanContextRow = DatabaseRow & { readonly request_context: unknown };

const sameId = (left: unknown, right: string): boolean =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

const readHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
): Promise<SessionContext> => {
  const rows = await transaction.query<HumanContextRow>`
    select vortex_access.validated_human_request_context() - 'channel' as request_context
  `;
  const parsed =
    rows.length === 1 ? sessionContextSchema.safeParse(rows[0]?.request_context) : undefined;
  if (
    parsed === undefined ||
    !parsed.success ||
    parsed.data.callerKind !== "human" ||
    !sameId(parsed.data.organizationId, scope.organizationId) ||
    !sameId(parsed.data.organizationAccountId, scope.organizationAccountId) ||
    !sameId(parsed.data.identityId, session.identityId) ||
    (scope.applicationRootId !== undefined &&
      !sameId(parsed.data.applicationRootId, scope.applicationRootId))
  )
    throw new Error("BUILDER_PREVIEW_HUMAN_CONTEXT_REFUSED");
  return parsed.data;
};

/** Reads only the persisted classification for the exact root in the validated organisation. */
const readApplicationRootClassification = async (
  transaction: RequestDatabaseTransaction,
  rootId: string | undefined,
): Promise<boolean> => {
  if (rootId === undefined) throw new Error("BUILDER_PREVIEW_ROOT_REQUIRED");
  const rows = await transaction.query<RootClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    throw new Error("BUILDER_PREVIEW_ROOT_UNAVAILABLE");
  return row.application_origin_kind === "platform_system_application";
};

const builderAuthority = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) =>
  createBuilderAuthority({
    transaction,
    scope,
    targetFacts: async (requestTransaction, _requestScope, rootId) => {
      const isSystemApplication = await readApplicationRootClassification(requestTransaction, rootId);
      return { isSystemApplication };
    },
  });

const previewCoordinator = () => {
  const installerRequests = humanOrganizationRequests();
  return createPreviewInstallationCoordinator({
    installerRequests,
    builderAuthority,
    draftCompiler: (transaction, authority) =>
      createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority),
  });
};

const operationRefusal = (
  reason: BuilderPreviewOperationRefusal["reason"],
  location: BuilderPreviewOperationLocation,
  validationErrors?: BuilderPreviewOperationRefusal["validationErrors"],
): BuilderPreviewOperationRefusal =>
  builderPreviewOperationRefusalSchema.parse({
    kind: "refused",
    reason,
    location,
    ...(validationErrors === undefined ? {} : { validationErrors }),
  });

const errorCodes = (error: unknown): readonly string[] => {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { readonly code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return codes;
};

const coordinatorRefusal = (
  error: unknown,
  location: BuilderPreviewOperationLocation,
): BuilderPreviewOperationRefusal => {
  const codes = errorCodes(error);
  if (
    codes.some((code) =>
      [
        "PREVIEW_INSTALLATION_PERMISSION_REFUSED",
        "BUILDER_PERMISSION_REFUSED",
        "BUILDER_RECENT_AUTHENTICATION_REQUIRED",
        "42501",
      ].includes(code),
    )
  )
    return operationRefusal("permission_refused", location);
  if (
    codes.some((code) =>
      [
        "PREVIEW_INSTALLATION_STALE",
        "DEFINITION_DRAFT_STALE_OR_MISSING",
        "DEFINITION_SOURCE_EVIDENCE_MISMATCH",
        "40001",
        "23514",
      ].includes(code),
    )
  )
    return operationRefusal("draft_stale", location);
  if (codes.includes("INVALID_PREVIEW_INSTALLATION_COMMAND"))
    return operationRefusal("invalid_request", location);
  if (codes.includes("PREVIEW_INSTALLATION_NOT_FOUND"))
    return operationRefusal("preview_unavailable", location);
  if (codes.includes("PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE"))
    return operationRefusal("temporarily_unavailable", location);
  if (
    codes.some((code) =>
      [
        "DEFINITION_COMPILATION_REFUSED",
        "DEFINITION_DEPENDENCY_MISSING",
        "DEFINITION_DEPENDENCY_PRERELEASE_ONLY",
        "DEFINITION_DEPENDENCY_INCOMPATIBLE",
        "DEFINITION_DEPENDENCY_AMBIGUOUS",
        "DEFINITION_DEPENDENCY_SUBSTITUTED",
        "DEFINITION_DEPENDENCY_CYCLE",
      ].includes(code),
    )
  )
    return operationRefusal("validation", location);
  if (error instanceof PreviewInstallationCoordinatorError) {
    if (error.code === "PREVIEW_INSTALLATION_REFUSED")
      return operationRefusal("permission_refused", location);
  }
  return operationRefusal("operation_failed", location);
};

const previewLocation = (
  address: Readonly<{
    organizationId: OrganizationId;
    applicationRootId: ApplicationRootId;
    previewInstallationId: string;
  }>,
): BuilderPreviewOperationLocation => ({
  kind: "preview",
  organizationId: address.organizationId,
  applicationRootId: address.applicationRootId,
  previewInstallationId: address.previewInstallationId,
});

const draftLocation = (request: Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  expectedDraftRevision: number;
}>): BuilderPreviewOperationLocation => ({
  kind: "draft",
  organizationId: request.organizationId,
  applicationRootId: request.applicationRootId,
  expectedDraftRevision: request.expectedDraftRevision,
});

const matchesExpectedDraft = (
  preview: Readonly<{ draftRevision: number }>,
  expectedDraftRevision: number,
): boolean => preview.draftRevision === expectedDraftRevision;

const isExpectedOrigin = (request: NextRequest): boolean => {
  const origin = request.headers.get("origin");
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    origin !== null &&
    origin === new URL(getIdentityJourneyConfiguration().siteUrl).origin &&
    contentType === "application/json"
  );
};

const refusalStatus = (reason: BuilderPreviewOperationRefusal["reason"]): number => {
  switch (reason) {
    case "unauthenticated":
      return 401;
    case "permission_refused":
      return 403;
    case "draft_stale":
    case "record_conflict":
      return 409;
    case "preview_expired":
      return 410;
    case "preview_unavailable":
    case "flow_unavailable":
      return 404;
    case "temporarily_unavailable":
      return 503;
    case "operation_failed":
      return 500;
    default:
      return 422;
  }
};

const responseStatus = (result: unknown): number => {
  if (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    (result as { readonly kind?: unknown }).kind === "refused" &&
    "reason" in result
  )
    return refusalStatus((result as BuilderPreviewOperationRefusal).reason);
  return 200;
};

/** Shared authenticated HTTP adapter. Each route supplies exactly one typed builder operation. */
export const handleBuilderPreviewOperationRequest = async <Schema extends z.ZodType>(
  request: NextRequest,
  requestSchema: Schema,
  operation: (session: IdentitySession, input: z.infer<Schema>) => Promise<unknown>,
): Promise<NextResponse> => {
  const requestLocation: BuilderPreviewOperationLocation = { kind: "request" };
  try {
    if (!isExpectedOrigin(request))
      return privateJsonResponse(
        operationRefusal("invalid_request", requestLocation),
        403,
      );
  } catch {
    return privateJsonResponse(
      operationRefusal("temporarily_unavailable", requestLocation),
      503,
    );
  }

  let identity: Awaited<ReturnType<typeof resolveIdentitySession>>;
  try {
    identity = await resolveIdentitySession();
  } catch {
    return privateJsonResponse(
      operationRefusal("temporarily_unavailable", requestLocation),
      503,
    );
  }
  if (identity.kind === "temporarily_unavailable")
    return privateJsonResponse(
      operationRefusal("temporarily_unavailable", requestLocation),
      503,
    );
  if (identity.kind !== "active")
    return privateJsonResponse(operationRefusal("unauthenticated", requestLocation), 401);
  const parsedSession = identitySessionSchema.safeParse(identity.session);
  if (!parsedSession.success)
    return privateJsonResponse(operationRefusal("unauthenticated", requestLocation), 401);

  const read = await readBoundedRequestText(request, maximumRequestBodyLength);
  if (read.kind === "too_large")
    return privateJsonResponse(operationRefusal("invalid_request", requestLocation), 413);
  if (read.kind === "unreadable")
    return privateJsonResponse(operationRefusal("invalid_request", requestLocation), 400);

  let candidate: unknown;
  try {
    candidate = JSON.parse(read.text);
  } catch {
    return privateJsonResponse(operationRefusal("invalid_request", requestLocation), 400);
  }
  const parsed = requestSchema.safeParse(candidate);
  if (!parsed.success)
    return privateJsonResponse(operationRefusal("invalid_request", requestLocation), 400);

  try {
    const result = await operation(parsedSession.data, parsed.data);
    return privateJsonResponse(result, responseStatus(result));
  } catch {
    return privateJsonResponse(
      operationRefusal("operation_failed", requestLocation),
      500,
    );
  }
};

const previewRecordPort = () =>
  createPreviewRecordPort({
    identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
    telemetry: appTelemetry,
  });

const flowTestRunner = () => {
  const requests = humanOrganizationRequests();
  const coordinator = previewCoordinator();
  return createFlowTestRunner({
    previews: coordinator,
    records: previewRecordPort(),
    async readPinnedModuleRelease(session, selection, moduleRootCandidate, releaseRevisionCandidate) {
      const moduleRoot = moduleRootIdSchema.safeParse(moduleRootCandidate);
      const releaseRevision = revisionSchema.safeParse(releaseRevisionCandidate);
      if (!moduleRoot.success || !releaseRevision.success) return undefined;
      const result = await requests.run(session, selection, async (transaction, scope) => {
        const context = await readHumanContext(transaction, scope, session);
        const release = await createDatabaseDefinitionPublicationRepository(transaction).read(
          context,
          (reader) =>
            reader.readModuleRelease(
              context.organizationId,
              moduleRoot.data,
              releaseRevision.data,
            ),
        );
        if (release === undefined || release.compilationOutput.kind !== "module") return undefined;
        const output = release.compilationOutput;
        const projected = moduleDefinitionConsumerReadResultV3Schema.safeParse({
          kind: "module",
          organizationId: release.organizationId,
          definitionKey: release.key,
          rootId: release.rootId,
          releaseRevision: release.releaseRevision,
          releaseVersion: release.releaseVersion,
          validationContractVersion: output.validationContractVersion,
          contentFingerprint: release.contentFingerprint,
          resolutionFingerprint: release.resolutionFingerprint,
          dependencyManifest: release.published.dependencyManifest,
          correlationId: context.correlationId,
          content: output.canonical.content,
        });
        return projected.success ? projected.data : undefined;
      });
      return result.kind === "available" ? result.value : undefined;
    },
    async resolvePreviewerOrganizationAccountId(session, selection) {
      const result = await requests.run(session, selection, async (_transaction, scope) =>
        scope.organizationAccountId,
      );
      return result.kind === "available" ? result.value : undefined;
    },
  });
};

export const builderPreviewOperations = Object.freeze({
  async createPreviewInstallation(
    session: IdentitySession,
    requestCandidate: z.infer<typeof builderPreviewCreateRequestSchema>,
  ) {
    const request = builderPreviewCreateRequestSchema.safeParse(requestCandidate);
    if (!request.success)
      return builderPreviewCreateResultSchema.parse(
        operationRefusal("invalid_request", { kind: "request" }),
      );
    const location = draftLocation(request.data);
    try {
      const previewInstallation = await previewCoordinator().create(session, request.data);
      return builderPreviewCreateResultSchema.parse({ kind: "created", previewInstallation });
    } catch (error) {
      return builderPreviewCreateResultSchema.parse(coordinatorRefusal(error, location));
    }
  },

  async readPreviewInstallation(
    session: IdentitySession,
    requestCandidate: z.infer<typeof builderPreviewReadRequestSchema>,
  ) {
    const request = builderPreviewReadRequestSchema.safeParse(requestCandidate);
    if (!request.success)
      return builderPreviewReadResultSchema.parse(
        operationRefusal("invalid_request", { kind: "request" }),
      );
    const location = previewLocation(request.data);
    try {
      const previewInstallation = await previewCoordinator().read(session, {
        organizationId: request.data.organizationId,
        applicationRootId: request.data.applicationRootId,
        previewInstallationId: request.data.previewInstallationId,
      });
      if (!matchesExpectedDraft(previewInstallation, request.data.expectedDraftRevision))
        return builderPreviewReadResultSchema.parse(
          operationRefusal("draft_stale", draftLocation(request.data)),
        );
      return builderPreviewReadResultSchema.parse({ kind: "read", previewInstallation });
    } catch (error) {
      return builderPreviewReadResultSchema.parse(coordinatorRefusal(error, location));
    }
  },

  async discardPreviewInstallation(
    session: IdentitySession,
    requestCandidate: z.infer<typeof builderPreviewDiscardRequestSchema>,
  ) {
    const request = builderPreviewDiscardRequestSchema.safeParse(requestCandidate);
    if (!request.success)
      return builderPreviewDiscardResultSchema.parse(
        operationRefusal("invalid_request", { kind: "request" }),
      );
    const location = previewLocation(request.data);
    try {
      const coordinator = previewCoordinator();
      const previewInstallation = await coordinator.read(session, {
        organizationId: request.data.organizationId,
        applicationRootId: request.data.applicationRootId,
        previewInstallationId: request.data.previewInstallationId,
      });
      if (!matchesExpectedDraft(previewInstallation, request.data.expectedDraftRevision))
        return builderPreviewDiscardResultSchema.parse(
          operationRefusal("draft_stale", draftLocation(request.data)),
        );
      const result = await coordinator.discard(session, {
        organizationId: request.data.organizationId,
        applicationRootId: request.data.applicationRootId,
        previewInstallationId: request.data.previewInstallationId,
      });
      return builderPreviewDiscardResultSchema.parse({ kind: "discarded", result });
    } catch (error) {
      return builderPreviewDiscardResultSchema.parse(coordinatorRefusal(error, location));
    }
  },

  async runFlowInPreview(
    session: IdentitySession,
    requestCandidate: z.infer<typeof builderPreviewRunFlowRequestSchema>,
  ) {
    const request = builderPreviewRunFlowRequestSchema.safeParse(requestCandidate);
    if (!request.success)
      return builderPreviewRunFlowResultSchema.parse(
        operationRefusal("invalid_request", { kind: "request" }),
      );
    const address = {
      organizationId: request.data.organizationId,
      applicationRootId: request.data.applicationRootId,
      previewInstallationId: request.data.previewInstallationId,
    };
    const location = {
      kind: "flow" as const,
      ...address,
      flowId: request.data.flowId,
    };
    try {
      const previewInstallation = await previewCoordinator().read(session, address);
      if (!matchesExpectedDraft(previewInstallation, request.data.expectedDraftRevision))
        return builderPreviewRunFlowResultSchema.parse(
          operationRefusal("draft_stale", draftLocation(request.data)),
        );
      const selection = organizationSelectionCandidateSchema.parse({
        organizationId: request.data.organizationId,
        applicationRootId: request.data.applicationRootId,
      });
      const response = await flowTestRunner().run(session, selection, {
        previewInstallationId: request.data.previewInstallationId,
        flowId: request.data.flowId,
        sampleInputs: request.data.sampleInputs,
      });
      const parsedResponse = flowTestRunResponseSchema.safeParse(response);
      if (!parsedResponse.success)
        return builderPreviewRunFlowResultSchema.parse(
          operationRefusal("operation_failed", location),
        );
      if (parsedResponse.data.kind === "refused") {
        const refusalLocation: BuilderPreviewOperationLocation =
          parsedResponse.data.location.kind === "flow"
            ? { kind: "flow", ...address, flowId: parsedResponse.data.location.flowId }
            : previewLocation(address);
        const reason =
          parsedResponse.data.reason === "invalid_request"
            ? "invalid_request"
            : parsedResponse.data.reason === "preview_expired"
              ? "preview_expired"
              : parsedResponse.data.reason === "flow_unavailable"
                ? "flow_unavailable"
                : parsedResponse.data.reason === "flow_not_runnable"
                  ? "flow_not_runnable"
                  : parsedResponse.data.reason === "flow_not_authorized"
                    ? "flow_not_authorized"
                    : parsedResponse.data.reason === "server_time_limit"
                      ? "operation_failed"
                      : "preview_unavailable";
        return builderPreviewRunFlowResultSchema.parse(
          operationRefusal(reason, refusalLocation),
        );
      }
      return builderPreviewRunFlowResultSchema.parse({
        kind: "completed",
        runId: parsedResponse.data.runId,
        flowId: parsedResponse.data.flowId,
        result: parsedResponse.data.result,
        trace: parsedResponse.data.trace,
        intents: parsedResponse.data.intents,
      });
    } catch (error) {
      return builderPreviewRunFlowResultSchema.parse(coordinatorRefusal(error, location));
    }
  },

  async saveRecordInPreview(
    session: IdentitySession,
    requestCandidate: z.infer<typeof builderPreviewSaveRecordRequestSchema>,
  ) {
    const request = builderPreviewSaveRecordRequestSchema.safeParse(requestCandidate);
    if (!request.success)
      return builderPreviewSaveRecordResultSchema.parse(
        operationRefusal("invalid_request", { kind: "request" }),
      );
    const address = {
      organizationId: request.data.organizationId,
      applicationRootId: request.data.applicationRootId,
      previewInstallationId: request.data.previewInstallationId,
    };
    const location: BuilderPreviewOperationLocation = {
      kind: "record",
      ...address,
      recordTypeId: request.data.command.recordTypeId,
      ...(request.data.command.operation === "update"
        ? { recordId: request.data.command.recordId }
        : {}),
    };
    try {
      const previewInstallation = await previewCoordinator().read(session, address);
      if (!matchesExpectedDraft(previewInstallation, request.data.expectedDraftRevision))
        return builderPreviewSaveRecordResultSchema.parse(
          operationRefusal("draft_stale", draftLocation(request.data)),
        );
      const selection = organizationSelectionCandidateSchema.parse({
        organizationId: request.data.organizationId,
        applicationRootId: request.data.applicationRootId,
      });
      const command = saveRecordCommandV2Schema.parse({
        ...request.data.command,
        previewInstallationId: request.data.previewInstallationId,
      });
      const saved = await previewRecordPort().save(session, selection, command);
      if (saved.kind === "temporarily_unavailable")
        return builderPreviewSaveRecordResultSchema.parse(
          operationRefusal("temporarily_unavailable", location),
        );
      if (saved.kind !== "available")
        return builderPreviewSaveRecordResultSchema.parse(
          operationRefusal("record_refused", location),
        );
      const result = saveRecordResultV2Schema.safeParse(saved.value);
      if (!result.success)
        return builderPreviewSaveRecordResultSchema.parse(
          operationRefusal("operation_failed", location),
        );
      if (result.data.outcome === "refused")
        return builderPreviewSaveRecordResultSchema.parse(
          operationRefusal(
            result.data.error.code === "conflict" ? "record_conflict" : "record_refused",
            location,
          ),
        );
      return builderPreviewSaveRecordResultSchema.parse({ kind: "completed", result: result.data });
    } catch (error) {
      return builderPreviewSaveRecordResultSchema.parse(coordinatorRefusal(error, location));
    }
  },
});
