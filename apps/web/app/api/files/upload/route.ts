import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  recordTypeIdSchema,
  recordIdSchema,
  fieldIdSchema,
  fileIdSchema,
  logRefusal,
} from "@vortex/platform/schema";
import { admitAttachmentUpload, completeAttachmentUpload } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { humanOrganizationRequests } from "../../../_lib/server-composition";
import { fileStorageSigningConfiguration } from "../../../_lib/server-configuration";
import { pageAddressSchema } from "../../../_lib/page-address-schema";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { privateJsonResponse } from "../../../_lib/private-response";
import { isOwnSiteJsonRequest, readJsonBody } from "../../_lib/own-site-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const selectorsSchema = pageAddressSchema
  .extend({
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema.optional(),
    fieldId: fieldIdSchema,
  })
  .strict();
const commandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("admit"),
      filename: z.string().min(1).max(255),
      mediaType: z.string().max(255),
      sizeBytes: z
        .number()
        .int()
        .positive()
        .max(5000 * 1024 * 1024),
      replacingFileId: fileIdSchema.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("complete"), fileId: fileIdSchema }).strict(),
]);
const refuse = (code: string, status = 403, cause?: unknown) => {
  logRefusal("files", "upload", code, cause);
  return privateJsonResponse(
    {
      outcome: "refused",
      message: "The file could not be uploaded. Refresh the page and try again.",
    },
    status,
  );
};
export async function POST(request: NextRequest) {
  try {
    const configuration = getIdentityJourneyConfiguration();
    if (!isOwnSiteJsonRequest(request)) return refuse("request_not_from_own_site");
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active") return refuse("identity_not_active", 401);
    const selectors = selectorsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!selectors.success) return refuse("selectors_invalid", 400, selectors.error);
    const input = selectors.data;
    const address = await resolveApplicationAddress(
      identity.session,
      input.tenantShortName,
      input.organizationShortName,
      input.applicationKey,
      input.pageKey,
    );
    if (address.kind !== "application_page") return refuse("page_refused");
    const body = await readJsonBody(request, 4096, commandSchema);
    if (body.kind === "too_large") return refuse("body_too_large", 413);
    if (body.kind !== "read") return refuse(`body_${body.kind}`, 400);
    const signing = fileStorageSigningConfiguration(configuration.supabaseUrl);
    const storage = {
      destination: signing.destination,
      key: { keyId: signing.keyId, signer: signing.privateKey },
    };
    const result = await humanOrganizationRequests().run(
      identity.session,
      {
        organizationId: address.read.organizationId,
        applicationRootId: address.application.applicationRootId,
        ...(address.application.previewInstallationId === undefined
          ? {}
          : { previewInstallationId: address.application.previewInstallationId }),
      },
      async (transaction) =>
        body.value.operation === "admit"
          ? admitAttachmentUpload(transaction, { ...input, ...body.value }, storage)
          : completeAttachmentUpload(transaction, { ...input, ...body.value }, storage),
    );
    if (result.kind !== "available") return refuse(`protected_${result.kind}`);
    if (result.value.outcome === "refused") logRefusal("files", "upload", "upload_refused");
    return privateJsonResponse(result.value, result.value.outcome === "refused" ? 422 : 200);
  } catch (error) {
    return refuse("upload_unavailable", 503, error);
  }
}
