import "server-only";

import { isReservedTenantSegment } from "@vortex/app";
import { builderKeySchema, namespacedKeySchema } from "@vortex/contracts";
import { organizationAddressPath } from "../../_lib/address-paths";

const applicationHomeContinuationBrand: unique symbol = Symbol("ApplicationHomeContinuation");
const maximumApplicationHomeLength = 1024;
const applicationHomeFields = [
  "tenantShortName",
  "organizationShortName",
  "applicationKey",
] as const;
const applicationHomeFieldSet: ReadonlySet<string> = new Set<string>(applicationHomeFields);

export type ApplicationHomeContinuation = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  readonly [applicationHomeContinuationBrand]: true;
}>;

const detachValidatedFields = (
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
): ApplicationHomeContinuation =>
  Object.freeze({
    tenantShortName,
    organizationShortName,
    applicationKey,
    [applicationHomeContinuationBrand]: true as const,
  });

const validateFields = (
  tenantValue: unknown,
  organizationValue: unknown,
  applicationValue: unknown,
): ApplicationHomeContinuation | undefined => {
  const tenant = builderKeySchema.safeParse(tenantValue);
  const organization = builderKeySchema.safeParse(organizationValue);
  const application = namespacedKeySchema.safeParse(applicationValue);
  if (
    !tenant.success ||
    !organization.success ||
    !application.success ||
    isReservedTenantSegment(tenant.data)
  )
    return undefined;

  return detachValidatedFields(tenant.data, organization.data, application.data);
};

/**
 * Returns a detached candidate only for an addressed application or application-page route.
 * The old page segment is intentionally discarded; organization launchers and malformed routes
 * do not produce a continuation.
 */
export const applicationHomeContinuationFromAddress = (
  tenantShortName: unknown,
  organizationShortName: unknown,
  applicationAddress: unknown,
): ApplicationHomeContinuation | undefined => {
  if (
    !Array.isArray(applicationAddress) ||
    (applicationAddress.length !== 1 && applicationAddress.length !== 2)
  )
    return undefined;
  if (
    applicationAddress.length === 2 &&
    !builderKeySchema.safeParse(applicationAddress[1]).success
  )
    return undefined;
  return validateFields(tenantShortName, organizationShortName, applicationAddress[0]);
};

/** Serialize only the three canonical routing fields, in their fixed order. */
export const serializeApplicationHomeContinuation = (
  continuation: ApplicationHomeContinuation,
): string =>
  JSON.stringify({
    tenantShortName: continuation.tenantShortName,
    organizationShortName: continuation.organizationShortName,
    applicationKey: continuation.applicationKey,
  });

/**
 * Parses the one bounded transport value. Comparing it with a serialization of a freshly
 * validated object rejects duplicate JSON members, alternate spellings and non-canonical forms.
 */
export const parseApplicationHomeContinuation = (
  value: unknown,
): ApplicationHomeContinuation | undefined => {
  if (typeof value !== "string" || value.length > maximumApplicationHomeLength) return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    )
      return undefined;

    const keys = Reflect.ownKeys(parsed);
    if (
      keys.length !== applicationHomeFields.length ||
      keys.some((key) => typeof key !== "string" || !applicationHomeFieldSet.has(key))
    )
      return undefined;

    const record = parsed as Record<(typeof applicationHomeFields)[number], unknown>;
    const continuation = validateFields(
      record.tenantShortName,
      record.organizationShortName,
      record.applicationKey,
    );
    if (
      continuation === undefined ||
      serializeApplicationHomeContinuation(continuation) !== value
    )
      return undefined;
    return continuation;
  } catch {
    return undefined;
  }
};

/** Duplicate query or form fields are refused, including repeated equal values. */
export const parseSingleApplicationHomeContinuation = (
  values: readonly unknown[],
): ApplicationHomeContinuation | undefined =>
  values.length === 1 ? parseApplicationHomeContinuation(values[0]) : undefined;

/** Build only the validated internal application-home address; no caller-supplied path is used. */
export const applicationHomeAddressPath = (
  continuation: ApplicationHomeContinuation,
): string =>
  `${organizationAddressPath(
    continuation.tenantShortName,
    continuation.organizationShortName,
  )}/${encodeURIComponent(continuation.applicationKey)}`;
