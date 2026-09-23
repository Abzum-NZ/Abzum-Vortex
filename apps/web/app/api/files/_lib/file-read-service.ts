import "server-only";

import {
  applicationRootIdSchema,
  fileIdSchema,
  organizationIdSchema,
  type FileId,
  type IdentitySession,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import { createHumanOrganizationRequestService } from "@vortex/access";
import { createAppTelemetryCollector } from "@vortex/app";
import {
  fileReadRefusalHttpStatus,
  privateFileResponseHeaders,
  type CurrentReadAuthority,
  type FileReadCoordinator,
  type FileReadPurpose,
  type FileReadRefusalReason,
  type FileReadResult,
  type FileReadViewer,
} from "@vortex/file";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { getIdentityAuthorityConfiguration } from "../../../auth/_lib/authority-configuration";

type HumanOrganizationRequestService = ReturnType<typeof createHumanOrganizationRequestService>;
type ProtectedRequestOperation = Parameters<HumanOrganizationRequestService["run"]>[2];
/** The Access-resolved, organisation-scoped request transaction of this request. */
export type ProtectedRequestTransaction = Parameters<ProtectedRequestOperation>[0];

export type FileReadAuthorityResolution =
  | Readonly<{ outcome: "authorized"; authority: CurrentReadAuthority }>
  | Readonly<{ outcome: "refused" }>;

/**
 * Trusted server port that runs inside the viewer's protected request
 * transaction. It loads the file's owning record binding and re-runs the
 * ordinary Access record read for that record, returning the viewer's current
 * readable attachment fields and, for a file of another organisation, the live
 * sharing grant. Nothing it returns is taken from the HTTP request.
 */
export type ResolveFileReadAuthority = (
  input: Readonly<{
    transaction: ProtectedRequestTransaction;
    scope: SelectedOrganizationScope;
    viewer: FileReadViewer;
    fileId: FileId;
    purpose: FileReadPurpose;
  }>,
) => Promise<FileReadAuthorityResolution>;

export type FileReadServiceInstallation = Readonly<{
  coordinator: FileReadCoordinator;
  resolveReadAuthority: ResolveFileReadAuthority;
}>;

const installationKey = Symbol.for("vortex.web.file-read-service");
type InstallationHolder = { [installationKey]?: FileReadServiceInstallation };

/**
 * Installs the durable File read service once, from trusted server start-up
 * wiring. Until then every file route fails closed; a second installation is
 * refused so a request path can never swap the service.
 */
export const installFileReadService = (installation: FileReadServiceInstallation): void => {
  const holder = globalThis as InstallationHolder;
  if (holder[installationKey] !== undefined) {
    throw new Error("The File read service is already installed");
  }
  if (
    typeof installation?.coordinator?.readFile !== "function" ||
    typeof installation.resolveReadAuthority !== "function"
  ) {
    throw new Error("The File read service installation is incomplete");
  }
  Object.defineProperty(holder, installationKey, {
    value: Object.freeze({ ...installation }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
};

const installedFileReadService = (): FileReadServiceInstallation | undefined =>
  (globalThis as InstallationHolder)[installationKey];

/**
 * The collector is stateless and frozen, so one instance is shared and then
 * injected explicitly into the Access dependencies.
 */
const requestTelemetry = createAppTelemetryCollector();

const refusalResponse = (
  reason: FileReadRefusalReason | "unauthenticated",
  headers?: Readonly<Record<string, string>>,
): Response => {
  const status = reason === "unauthenticated" ? 401 : fileReadRefusalHttpStatus[reason];
  const response = Response.json({ outcome: "refused", reason }, { status });
  for (const [name, value] of Object.entries({ ...privateFileResponseHeaders(), ...headers })) {
    response.headers.set(name, value);
  }
  return response;
};

const sameViewer = (left: FileReadViewer, right: FileReadViewer): boolean =>
  left.organizationId === right.organizationId &&
  left.applicationRootId === right.applicationRootId &&
  left.actor.kind === "human" &&
  right.actor.kind === "human" &&
  left.actor.organizationAccountId === right.actor.organizationAccountId &&
  left.actor.identityId === right.actor.identityId;

const toResponse = (result: FileReadResult): Response => {
  if (result.outcome === "refused") return refusalResponse(result.reason, result.headers);
  return new Response(result.stream, {
    status: result.statusCode,
    headers: { ...result.headers },
  });
};

export type FileRouteParameters = Readonly<{ organizationId: string; fileId: string }>;

/**
 * Serves one private download, range or preview request. The signed-in
 * identity is re-verified, the organisation in the route (and optional
 * `applicationRootId` query value) is only a selection candidate that the
 * Access human-organisation request must accept for this identity's current
 * account, and the installed resolver re-runs record and attachment-field
 * authority inside that protected transaction. The File read coordinator then
 * re-verifies the result and streams the bytes through a one-request,
 * server-held credential. A copied route therefore fails for another account
 * and after revocation, and no response redirects to Storage.
 */
export const handleFileReadRequest = async (
  request: Request,
  parameters: FileRouteParameters,
  purpose: FileReadPurpose,
): Promise<Response> => {
  const organizationId = organizationIdSchema.safeParse(parameters.organizationId);
  const fileId = fileIdSchema.safeParse(parameters.fileId);
  const requestedApplication = new URL(request.url).searchParams.get("applicationRootId");
  const applicationRootId =
    requestedApplication === null ? undefined : applicationRootIdSchema.safeParse(requestedApplication);
  if (
    !organizationId.success ||
    !fileId.success ||
    (applicationRootId !== undefined && !applicationRootId.success)
  ) {
    return refusalResponse("malformed_request");
  }

  const identity = await resolveIdentitySession();
  if (identity.kind === "temporarily_unavailable") return refusalResponse("storage_unavailable");
  if (identity.kind !== "active") return refusalResponse("unauthenticated");
  const session: IdentitySession = identity.session;

  const service = installedFileReadService();
  if (service === undefined) return refusalResponse("storage_unavailable");

  let identityAuthorityId;
  try {
    identityAuthorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch {
    return refusalResponse("storage_unavailable");
  }

  const targetFileId = fileId.data;
  const protectedResult = await createHumanOrganizationRequestService({
    identityAuthorityId,
    telemetry: requestTelemetry,
  }).run(
    session,
    {
      organizationId: organizationId.data,
      ...(applicationRootId === undefined || !applicationRootId.success
        ? {}
        : { applicationRootId: applicationRootId.data }),
    },
    async (transaction, scope) => {
      const viewer: FileReadViewer = Object.freeze({
        organizationId: scope.organizationId,
        actor: Object.freeze({
          kind: "human" as const,
          organizationAccountId: scope.organizationAccountId,
          identityId: session.identityId,
        }),
        ...(scope.applicationRootId === undefined
          ? {}
          : { applicationRootId: scope.applicationRootId }),
      });
      const resolution = await service.resolveReadAuthority({
        transaction,
        scope,
        viewer,
        fileId: targetFileId,
        purpose,
      });
      return { viewer, resolution };
    },
  );
  if (protectedResult.kind === "temporarily_unavailable") {
    return refusalResponse("storage_unavailable");
  }
  // Another account, a revoked account or a record the viewer can no longer
  // read all look the same: the file is not found for this viewer.
  if (protectedResult.kind !== "available") return refusalResponse("file_not_found");
  const { viewer, resolution } = protectedResult.value;
  if (resolution.outcome !== "authorized" || !sameViewer(resolution.authority.viewer, viewer)) {
    return refusalResponse("file_not_found");
  }

  const rangeHeader = request.headers.get("range");
  const ifRangeHeader = request.headers.get("if-range");
  let result: FileReadResult;
  try {
    result = await service.coordinator.readFile(resolution.authority, {
      fileId: targetFileId,
      purpose,
      ...(rangeHeader === null ? {} : { rangeHeader }),
      ...(ifRangeHeader === null ? {} : { ifRangeHeader }),
    });
  } catch {
    return refusalResponse("storage_unavailable");
  }
  return toResponse(result);
};
