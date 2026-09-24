import "server-only";

import {
  applicationRootIdSchema,
  identitySessionSchema,
  organizationIdSchema,
  type IdentitySession,
} from "@vortex/contracts";
import { withRuntimeTransaction } from "@vortex/db";
import { z } from "zod";

const routeKeySchema = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9._-]*$/);
const pageKeySchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export const permittedApplicationSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    key: z.string().min(3).max(120),
    name: z.string().trim().min(1).max(120),
    icon: z.string().trim().min(1).max(120),
    homePageKey: pageKeySchema,
    pageKeys: z.array(pageKeySchema).min(1).max(10_000),
  })
  .strict();

export const permittedApplicationsReadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      organizationId: organizationIdSchema,
      tenantShortName: routeKeySchema,
      organizationShortName: routeKeySchema,
      defaultApplicationRootId: applicationRootIdSchema.nullable(),
      applications: z.array(permittedApplicationSchema).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export type PermittedApplication = z.infer<typeof permittedApplicationSchema>;
export type PermittedApplicationsRead = z.infer<typeof permittedApplicationsReadSchema>;

type AddressRow = Readonly<{ address: unknown }>;

/** Resolve an address only after the current identity has a live account in that exact org. */
export const readPermittedApplicationsAtAddress = async (
  session: IdentitySession,
  tenantShortNameCandidate: string,
  organizationShortNameCandidate: string,
): Promise<PermittedApplicationsRead> => {
  const parsedSession = identitySessionSchema.safeParse(session);
  const tenantShortName = routeKeySchema.safeParse(tenantShortNameCandidate);
  const organizationShortName = routeKeySchema.safeParse(organizationShortNameCandidate);
  if (!parsedSession.success || !tenantShortName.success || !organizationShortName.success)
    return { kind: "unavailable" };

  if (Date.parse(parsedSession.data.accessTokenExpiresAt) <= Date.now())
    return { kind: "unavailable" };

  try {
    const result = await withRuntimeTransaction(async (transaction) => {
      const rows = await transaction.query<AddressRow>`
        select vortex_module.read_permitted_applications_at_address(
          ${parsedSession.data.identityId}::uuid,
          ${tenantShortName.data}::text,
          ${organizationShortName.data}::text
        ) as address
      `;
      if (rows.length !== 1) throw new Error("INVALID_APPLICATION_ADDRESS_RESULT");
      return permittedApplicationsReadSchema.parse(rows[0]?.address);
    });
    return result;
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

/** A requested application or page is selected only from the safe permitted-app list. */
export const resolvePermittedApplicationAddress = (
  read: PermittedApplicationsRead,
  applicationKeyCandidate?: string,
  pageKeyCandidate?: string,
) => {
  if (read.kind !== "available") return read;
  if (applicationKeyCandidate === undefined)
    return { kind: "available" as const, read, application: null, pageKey: null };

  const applicationKey = routeKeySchema.safeParse(applicationKeyCandidate);
  if (!applicationKey.success) return { kind: "unavailable" as const };
  const application = read.applications.find((entry) => entry.key === applicationKey.data);
  if (!application) return { kind: "unavailable" as const };

  const pageKey = pageKeyCandidate === undefined
    ? application.homePageKey
    : pageKeySchema.safeParse(pageKeyCandidate).success
      ? pageKeySchema.parse(pageKeyCandidate)
      : null;
  if (pageKey === null || !application.pageKeys.includes(pageKey))
    return { kind: "unavailable" as const };

  return { kind: "available" as const, read, application, pageKey };
};
