import "server-only";

import { isReservedTenantSegment } from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  builderKeySchema,
  namespacedKeySchema,
  organizationIdSchema,
  recordIdSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import { organizationAddressPath } from "../../_lib/address-paths";
import { pageSubjectParameter } from "../../_lib/application-page/placement-helpers";

/** Only known Studio routes can be resumed; a supplied origin or arbitrary path is never used. */
const studioAddressSchema = z
  .string()
  .max(4096)
  .refine((address) => {
    if (/[\\#\s]/u.test(address)) return false;
    const [pathname] = address.split("?");
    const segments = pathname!.split("/");
    if (segments[0] !== "" || segments[1] !== "studio") return false;
    if (segments.length === 2) return true;
    if (!organizationIdSchema.safeParse(segments[2]).success) return false;
    if (segments.length === 3) return true;
    if (segments[3] === "new") return segments.length === 4;
    if (!applicationRootIdSchema.safeParse(segments[3]).success) return false;
    return (
      segments.length === 4 ||
      (segments.length === 5 && ["history", "page-adoption"].includes(segments[4]!))
    );
  });

const continuationSchema = z
  .discriminatedUnion("kind", [
    // The application page the person was opening: its application, its page (absent for the
    // application's home) and the record it shows, if any. The page rechecks access when it opens.
    z
      .object({
        kind: z.literal("application_page"),
        tenantShortName: builderKeySchema.refine((value) => !isReservedTenantSegment(value)),
        organizationShortName: builderKeySchema,
        applicationKey: namespacedKeySchema,
        pageKey: builderKeySchema.optional(),
        recordId: recordIdSchema.optional(),
      })
      .strict(),
    z.object({ kind: z.literal("studio"), address: studioAddressSchema }).strict(),
  ])
  .readonly()
  .brand("SignInContinuation");

export type SignInContinuation = z.infer<typeof continuationSchema>;

/** An application page continues at that page, with the record it shows when it shows one. */
export const applicationPageContinuationFromAddress = (
  tenantShortName: unknown,
  organizationShortName: unknown,
  applicationAddress: unknown,
  recordId: unknown,
): SignInContinuation | undefined => {
  if (
    !Array.isArray(applicationAddress) ||
    (applicationAddress.length !== 1 && applicationAddress.length !== 2) ||
    (applicationAddress.length === 2 && !builderKeySchema.safeParse(applicationAddress[1]).success)
  )
    return undefined;
  const record = recordIdSchema.safeParse(recordId);
  const result = continuationSchema.safeParse({
    kind: "application_page",
    tenantShortName,
    organizationShortName,
    applicationKey: applicationAddress[0],
    ...(applicationAddress.length === 2 ? { pageKey: applicationAddress[1] } : {}),
    ...(applicationAddress.length === 2 && record.success ? { recordId: record.data } : {}),
  });
  return result.success ? result.data : undefined;
};

/** The address comes from the proxy-owned request header, including the Studio tab query. */
export const studioContinuationFromAddress = (address: unknown): SignInContinuation | undefined => {
  const result = continuationSchema.safeParse({ kind: "studio", address });
  return result.success ? result.data : undefined;
};

/** One bounded, canonical transport for all sign-in continuations. */
export const serializeSignInContinuation = (continuation: SignInContinuation): string =>
  JSON.stringify(continuation);

export const parseSignInContinuation = (value: unknown): SignInContinuation | undefined => {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const result = continuationSchema.safeParse(JSON.parse(value));
    if (!result.success || serializeSignInContinuation(result.data) !== value) return undefined;
    return result.data;
  } catch {
    return undefined;
  }
};

/** Duplicate query or form fields are refused, including repeated equal values. */
export const parseSingleSignInContinuation = (
  values: readonly unknown[],
): SignInContinuation | undefined =>
  values.length === 1 ? parseSignInContinuation(values[0]) : undefined;

export const signInContinuationAddressPath = (continuation: SignInContinuation): string => {
  if (continuation.kind === "studio") return continuation.address;
  const application = `${organizationAddressPath(continuation.tenantShortName, continuation.organizationShortName)}/${encodeURIComponent(continuation.applicationKey)}`;
  if (continuation.pageKey === undefined) return application;
  const page = `${application}/${encodeURIComponent(continuation.pageKey)}`;
  return continuation.recordId === undefined
    ? page
    : `${page}?${new URLSearchParams({ [pageSubjectParameter]: continuation.recordId })}`;
};
