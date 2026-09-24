import "server-only";

import {
  fileIdSchema,
  organizationIdSchema,
  type FileId,
  type IdentitySession,
} from "@vortex/contracts";
import { createHumanOrganizationRequestService } from "@vortex/access";
import { createAppTelemetryCollector, createOperationsAlertSink } from "@vortex/app";
import {
  composeStorageAuthorityResolvers,
  createDefaultUpstreamStorageReader,
  createFileReadCoordinator,
  createReadStorageAuthorityResolver,
  createSqlFileReadRepository,
  createStorageCredentialBridge,
  createStorageSignerFromPrivateKey,
  decideFileRead,
  fileReadRefusalHttpStatus,
  locateFileApplication,
  privateFileResponseHeaders,
  type FileReadPurpose,
  type FileReadRefusalReason,
  type FileReadResult,
  type StorageKeySigner,
} from "@vortex/file";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import {
  getIdentityAuthorityConfiguration,
  getIdentityJourneyConfiguration,
} from "../../../auth/_lib/authority-configuration";

/** How long one protected read decision may be relied on before its grant is recorded. */
const READ_DECISION_SECONDS = 30;

type StorageSigningConfiguration = Readonly<{
  destinationProject: string;
  issuer: string;
  keyId: string;
  signer: StorageKeySigner;
}>;

let signingConfiguration: StorageSigningConfiguration | undefined;

const requiredEnvironmentValue = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
};

/**
 * The destination project's File Storage signing key, held only in the server
 * secret store. The destination is the configured Supabase project; a local
 * or non-Supabase address has no Storage bridge, so private reads fail closed.
 */
const storageSigningConfiguration = (): StorageSigningConfiguration => {
  if (signingConfiguration !== undefined) return signingConfiguration;
  const hostname = new URL(getIdentityJourneyConfiguration().supabaseUrl).hostname;
  const match = /^([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.supabase\.co$/.exec(hostname);
  if (match === null || match[1] === undefined) {
    throw new Error("File Storage requires a hosted Supabase destination project");
  }
  const destinationProject = match[1];
  const privateKey = requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY").replace(
    /\\n/g,
    "\n",
  );
  signingConfiguration = Object.freeze({
    destinationProject,
    issuer: `https://${destinationProject}.supabase.co/auth/v1`,
    keyId: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY_ID"),
    signer: createStorageSignerFromPrivateKey(privateKey),
  });
  return signingConfiguration;
};

const upstreamStorageReader = createDefaultUpstreamStorageReader();

/**
 * The collector is stateless and frozen, so one instance is shared and then
 * injected explicitly into the Access dependencies.
 */
const requestTelemetry = createAppTelemetryCollector({
  downstream: createOperationsAlertSink(),
});

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

type ProtectedRead =
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "read"; result: FileReadResult }>;

export type FileRouteParameters = Readonly<{ organizationId: string; fileId: string }>;

/**
 * Serves one private download, range or preview request.
 *
 * 1. The signed-in identity is re-verified from its session.
 * 2. The organisation in the route is only a selection candidate: the Access
 *    human-organisation request must accept it for this identity's current
 *    account, first to locate the file's application inside that organisation.
 * 3. A second, application-scoped protected request re-runs the protected
 *    record read of the file's owning record, requires its attachment field to
 *    be readable and to still name the file, records a one-time grant, and
 *    claims it through the Storage credential bridge for one server-held
 *    credential of at most 60 seconds.
 * 4. Bytes stream through this server; no Storage address, bearer or redirect
 *    reaches the client.
 *
 * Another account, a revoked account, an unreadable record or field and a
 * detached file all look the same: the file is not found for this viewer.
 */
export const handleFileReadRequest = async (
  request: Request,
  parameters: FileRouteParameters,
  purpose: FileReadPurpose,
): Promise<Response> => {
  const organizationId = organizationIdSchema.safeParse(parameters.organizationId);
  const fileId = fileIdSchema.safeParse(parameters.fileId);
  if (!organizationId.success || !fileId.success) return refusalResponse("malformed_request");
  const targetOrganizationId = organizationId.data;
  const targetFileId: FileId = fileId.data;

  const identity = await resolveIdentitySession();
  if (identity.kind === "temporarily_unavailable") return refusalResponse("storage_unavailable");
  if (identity.kind !== "active") return refusalResponse("unauthenticated");
  const session: IdentitySession = identity.session;

  let identityAuthorityId;
  let signing: StorageSigningConfiguration;
  try {
    identityAuthorityId = getIdentityAuthorityConfiguration().authorityId;
    signing = storageSigningConfiguration();
  } catch {
    return refusalResponse("storage_unavailable");
  }
  const protectedRequests = createHumanOrganizationRequestService({
    identityAuthorityId,
    telemetry: requestTelemetry,
  });

  const located = await protectedRequests.run(
    session,
    { organizationId: targetOrganizationId },
    (transaction) => locateFileApplication(transaction, targetFileId),
  );
  if (located.kind === "temporarily_unavailable") return refusalResponse("storage_unavailable");
  if (located.kind !== "available" || located.value.outcome !== "located") {
    return refusalResponse("file_not_found");
  }
  const applicationRootId = located.value.applicationRootId;

  const rangeHeader = request.headers.get("range");
  const ifRangeHeader = request.headers.get("if-range");
  // An opened upstream body is cancelled if the protected transaction then
  // fails to commit, so no Storage stream is left open.
  const opened: { stream?: ReadableStream<Uint8Array> } = {};
  const protectedRead = await protectedRequests.run(
    session,
    { organizationId: targetOrganizationId, applicationRootId },
    async (transaction, scope, issuedAt): Promise<ProtectedRead> => {
      const decision = await decideFileRead(transaction, targetFileId);
      if (
        decision.outcome !== "allowed" ||
        decision.organizationId !== scope.organizationId ||
        decision.applicationRootId !== scope.applicationRootId
      ) {
        return { outcome: "not_found" };
      }

      // The grant store and the bridge's read resolver are bound to this
      // protected transaction, so the grant is recorded and claimed under the
      // same current request context that just decided authority.
      const repository = createSqlFileReadRepository(transaction);
      const bridge = createStorageCredentialBridge({
        destinationProject: signing.destinationProject,
        issuer: signing.issuer,
        activeKeyId: signing.keyId,
        keys: [{ keyId: signing.keyId, signer: signing.signer }],
        resolveCurrentAuthority: composeStorageAuthorityResolvers({
          read: createReadStorageAuthorityResolver(repository),
        }),
      });
      const coordinator = createFileReadCoordinator({
        repository,
        bridge,
        upstreamStorageReader,
      });
      const result = await coordinator.readFile(
        {
          viewer: {
            organizationId: scope.organizationId,
            actor: {
              kind: "human",
              organizationAccountId: scope.organizationAccountId,
              identityId: session.identityId,
            },
            applicationRootId,
          },
          recordTypeId: decision.recordTypeId,
          recordId: decision.recordId,
          fieldId: decision.fieldId,
          readableFieldIds: [decision.fieldId],
          validUntil: new Date(
            Date.parse(issuedAt) + READ_DECISION_SECONDS * 1_000,
          ).toISOString(),
        },
        {
          fileId: targetFileId,
          purpose,
          ...(rangeHeader === null ? {} : { rangeHeader }),
          ...(ifRangeHeader === null ? {} : { ifRangeHeader }),
        },
      );
      if (result.outcome === "success") opened.stream = result.stream;
      return { outcome: "read", result };
    },
  );

  if (protectedRead.kind !== "available") {
    await opened.stream?.cancel().catch(() => undefined);
    return refusalResponse(
      protectedRead.kind === "temporarily_unavailable" ? "storage_unavailable" : "file_not_found",
    );
  }
  if (protectedRead.value.outcome === "not_found") return refusalResponse("file_not_found");
  const result = protectedRead.value.result;
  if (result.outcome === "refused") return refusalResponse(result.reason, result.headers);
  return new Response(result.stream, {
    status: result.statusCode,
    headers: { ...result.headers },
  });
};
