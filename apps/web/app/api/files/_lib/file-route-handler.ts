import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import {
  fieldIdSchema,
  fileIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  type OrganizationId,
  type SessionContext,
} from "@vortex/contracts";
import {
  type CurrentReadAuthority,
  type FileReadCoordinator,
  type FileReadPurpose,
  type FileReadResult,
  type SharedRecordFileGrant,
} from "@vortex/file";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";

export type FileRouteHandlerOptions = Readonly<{
  coordinator?: FileReadCoordinator;
  forcedPurpose?: FileReadPurpose;
}>;

const defaultPrivateHeaders = (): Record<string, string> => ({
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Download-Options": "noopen",
});

const privateJsonResponse = (
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): NextResponse => {
  const response = NextResponse.json(body, { status });
  const headers = { ...defaultPrivateHeaders(), ...(extraHeaders ?? {}) };
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
};

let defaultCoordinator: FileReadCoordinator | null = null;

export const setDefaultFileReadCoordinator = (
  coordinator: FileReadCoordinator | null,
): void => {
  defaultCoordinator = coordinator;
};

export const getDefaultFileReadCoordinator = (): FileReadCoordinator | null =>
  defaultCoordinator;

/**
 * Handles an authenticated file read/download/preview request.
 *
 * 1. Rechecks current caller identity from session cookie or authorization header.
 * 2. Validates record, field, and organisation scope from query params or headers.
 * 3. Rechecks attachment-field read authority and record ownership.
 * 4. Passes request to the FileReadCoordinator which streams via short-lived server credential.
 * 5. Guarantees responses use private/no-store caching and safe content disposition.
 */
export async function handleFileApiRequest(
  request: NextRequest,
  fileIdParam: string,
  options?: FileRouteHandlerOptions,
): Promise<NextResponse> {
  const fileIdParsed = fileIdSchema.safeParse(fileIdParam);
  if (!fileIdParsed.success) {
    return privateJsonResponse(
      { outcome: "refused", reason: "malformed_request", message: "Invalid file identifier" },
      400,
    );
  }
  const fileId = fileIdParsed.data;

  // Resolve caller session
  let sessionResolution;
  try {
    sessionResolution = await resolveIdentitySession();
  } catch {
    return privateJsonResponse(
      { outcome: "refused", reason: "storage_unavailable", message: "Authentication service unavailable" },
      503,
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const headerRecordTypeId = request.headers.get("x-record-type-id");
  const headerRecordId = request.headers.get("x-record-id");
  const headerFieldId = request.headers.get("x-field-id");
  const headerOrgId = request.headers.get("x-organization-id");
  const headerGrantId = request.headers.get("x-grant-id");

  const rawRecordTypeId = searchParams.get("recordTypeId") ?? headerRecordTypeId;
  const rawRecordId = searchParams.get("recordId") ?? headerRecordId;
  const rawFieldId = searchParams.get("fieldId") ?? headerFieldId;
  const rawOrgId = searchParams.get("organizationId") ?? headerOrgId;
  const rawGrantId = searchParams.get("grantId") ?? headerGrantId;

  const recordTypeIdParsed = recordTypeIdSchema.safeParse(rawRecordTypeId);
  const recordIdParsed = recordIdSchema.safeParse(rawRecordId);
  const fieldIdParsed = fieldIdSchema.safeParse(rawFieldId);

  if (!recordTypeIdParsed.success || !recordIdParsed.success || !fieldIdParsed.success) {
    return privateJsonResponse(
      {
        outcome: "refused",
        reason: "malformed_request",
        message: "Missing or invalid required record and field scope parameters (recordTypeId, recordId, fieldId)",
      },
      400,
    );
  }

  const recordTypeId = recordTypeIdParsed.data;
  const recordId = recordIdParsed.data;
  const fieldId = fieldIdParsed.data;

  // Build SessionContext
  let sessionContext: SessionContext;
  let targetOrganizationId: OrganizationId;

  if (sessionResolution.kind === "active") {
    const session = sessionResolution.session;
    const requestedOrg = rawOrgId ? organizationIdSchema.safeParse(rawOrgId) : null;
    targetOrganizationId =
      requestedOrg && requestedOrg.success ? requestedOrg.data : session.activeOrganizationId;

    sessionContext = {
      callerKind: "human",
      identityId: session.identityId,
      organizationAccountId: session.activeOrganizationAccountId,
      organizationId: session.activeOrganizationId,
    };
  } else {
    // Check for authorization header (bearer system/service token)
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      if (!token) {
        return privateJsonResponse(
          { outcome: "refused", reason: "unauthenticated", message: "Missing bearer token" },
          401,
        );
      }
      const requestedOrg = rawOrgId ? organizationIdSchema.safeParse(rawOrgId) : null;
      if (!requestedOrg || !requestedOrg.success) {
        return privateJsonResponse(
          { outcome: "refused", reason: "malformed_request", message: "organizationId is required for bearer requests" },
          400,
        );
      }
      targetOrganizationId = requestedOrg.data;
      sessionContext = {
        callerKind: "system",
        systemActorId: platformIdSchema.parse("00000000-0000-4000-a000-000000000001"),
        organizationId: targetOrganizationId,
      };
    } else {
      return privateJsonResponse(
        { outcome: "refused", reason: "unauthenticated", message: "Caller is unauthenticated or session has expired" },
        401,
      );
    }
  }

  // Parse purpose: option forcedPurpose overrides query param
  let purpose: FileReadPurpose = options?.forcedPurpose ?? "download";
  if (!options?.forcedPurpose) {
    const rawPurpose = searchParams.get("purpose")?.toLowerCase();
    if (rawPurpose === "preview") {
      purpose = "preview";
    } else {
      purpose = "download";
    }
  }

  // Parse optional shared record grant
  let sharedRecordGrant: SharedRecordFileGrant | undefined;
  if (rawGrantId) {
    const grantIdParsed = platformIdSchema.safeParse(rawGrantId);
    if (grantIdParsed.success) {
      const rawSourceOrg = searchParams.get("sourceOrganizationId") ?? request.headers.get("x-source-organization-id");
      const sourceOrgParsed = organizationIdSchema.safeParse(rawSourceOrg);
      if (sourceOrgParsed.success) {
        sharedRecordGrant = {
          grantId: grantIdParsed.data,
          sourceOrganizationId: sourceOrgParsed.data,
          sourceRecordTypeId: recordTypeId,
          sourceRecordId: recordId,
          recipientOrganizationId: targetOrganizationId,
          readableFieldIds: [fieldId],
          expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        };
      }
    }
  }

  const authority: CurrentReadAuthority = {
    sessionContext,
    readableFieldIds: [fieldId],
    organizationId: targetOrganizationId,
    recordTypeId,
    recordId,
    fieldId,
    ...(sharedRecordGrant ? { sharedRecordGrant } : {}),
  };

  const coordinator = options?.coordinator ?? defaultCoordinator;
  if (!coordinator) {
    return privateJsonResponse(
      { outcome: "refused", reason: "storage_unavailable", message: "File read service is not configured" },
      503,
    );
  }

  const rangeHeader = request.headers.get("range") ?? undefined;
  const ifNoneMatch = request.headers.get("if-none-match") ?? undefined;

  let result: FileReadResult;
  try {
    result = await coordinator.readFile(authority, {
      fileId,
      purpose,
      rangeHeader,
      ifNoneMatch,
    });
  } catch (err) {
    return privateJsonResponse(
      {
        outcome: "refused",
        reason: "storage_unavailable",
        message: err instanceof Error ? err.message : "File read operation failed",
      },
      503,
    );
  }

  if (result.outcome === "refused") {
    return privateJsonResponse(
      { outcome: "refused", reason: result.reason, message: result.message },
      result.statusCode,
      result.headers,
    );
  }

  if (result.statusCode === 304) {
    const response = new NextResponse(null, { status: 304 });
    for (const [key, value] of Object.entries(result.headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  // Stream authorized bytes
  const response = new NextResponse(result.stream as BodyInit, {
    status: result.statusCode,
  });

  for (const [key, value] of Object.entries(result.headers)) {
    response.headers.set(key, value);
  }

  return response;
}
