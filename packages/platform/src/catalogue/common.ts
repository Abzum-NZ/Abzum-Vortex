import { z } from "zod";
import { builderKeySchema, fieldIdSchema, platformIdSchema } from "./identifiers";
import { cloneJsonValue, isJsonValue, type JsonValue } from "./json-value";
export type { JsonValue } from "./json-value";

/**
 * One sort key: a field, spelled in lower case whatever the sender wrote, and a direction. It is
 * the one shape of a sort in a query definition, a protected query request, a stored view and a
 * Studio canvas read.
 */
export const sortKeySchema = z
  .object({
    fieldId: fieldIdSchema.transform((fieldId) => fieldId.toLowerCase()),
    direction: z.enum(["ascending", "descending"]),
  })
  .strict();

export const labelSchema = z.string().trim().min(1).max(60);
export const descriptionSchema = z.string().trim().min(1).max(1_000);
/**
 * The longest external address an authored link or web-address value may carry, from the
 * applications specification. It bounds what a definition can make the browser handle.
 */
export const safeHttpsUrlMaximumLength = 2_048;
/** The parsed address, or undefined when it does not parse (the format check reports that). */
const parsedHttpsUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
    // guard-allow: silent-catch URL throws for text that is not an address; the format check reports it.
  } catch {
    return undefined;
  }
};
/**
 * One approved external address: HTTPS only, no embedded username or password, and at most
 * `safeHttpsUrlMaximumLength` characters. An address failing any of these is refused before it
 * can be rendered, stored or navigated to, so no code path has to strip a credential.
 */
export const safeHttpsUrlSchema = z
  .url({
    protocol: /^https$/,
    error: "Only valid HTTPS addresses are accepted",
  })
  .max(safeHttpsUrlMaximumLength)
  // A failed format check does not stop these refinements, so an unparseable value passes them
  // (it is already refused above) rather than throwing out of `safeParse`.
  .refine(
    (value) => {
      const address = parsedHttpsUrl(value);
      return address === undefined || (address.username === "" && address.password === "");
    },
    { message: "HTTPS addresses must not carry embedded credentials" },
  )
  // Chromium percent-encodes host characters a conforming parser refuses ("exa mple.com"), so a
  // host carrying "%" is refused to give the browser and the server the same answer.
  .refine((value) => !(parsedHttpsUrl(value)?.hostname.includes("%") ?? false), {
    message: "Only valid HTTPS addresses are accepted",
  });
export const duplicateProtectionKeySchema = z.string().min(16).max(200);
export const correlationIdSchema = platformIdSchema.brand<"CorrelationId">();
/** Closed safety limits shared by every authored and canonical condition tree. */
export const conditionMaximumNestingDepth = 10;
export const conditionMaximumOperandCount = 100;
export const jsonValueSchema: z.ZodType<JsonValue> = z
  .custom<JsonValue>(isJsonValue, { error: "Use a JSON value" })
  .transform(cloneJsonValue);

export const secretReferenceSchema = z
  .object({
    provider: z.literal("doppler"),
    referenceId: platformIdSchema,
    key: builderKeySchema,
    version: z.string().min(1).max(120).optional(),
  })
  .strict();

export const retryPolicySchema = z
  .object({
    maximumAttempts: z.number().int().min(1).max(20),
    initialDelaySeconds: z.number().int().min(0).max(86_400),
    maximumDelaySeconds: z.number().int().min(0).max(86_400),
    backoff: z.enum(["fixed", "exponential"]),
  })
  .strict()
  .refine((value) => value.maximumDelaySeconds >= value.initialDelaySeconds, {
    path: ["maximumDelaySeconds"],
    message: "Maximum delay cannot be shorter than initial delay",
  });

export const boundedPageSchema = z
  .object({
    pageSize: z.number().int().min(1).max(500),
    continuationToken: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export type CorrelationId = z.infer<typeof correlationIdSchema>;

const MAXIMUM_LINK_ADDRESS_LENGTH = 2_048;
/**
 * The schemes a link cell may use. A web address must carry no embedded credential; a mail or
 * telephone address must carry only its own characters. Anything else, a script address included,
 * is refused before it can be rendered.
 */
export const isSafeLinkAddress = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_LINK_ADDRESS_LENGTH)
    return false;
  let address: URL;
  try {
    address = new URL(value);
    // guard-allow: silent-catch URL throws for text that is not an address; the caller refuses it as unsafe.
  } catch {
    return false;
  }
  switch (address.protocol) {
    case "https:":
    case "http:":
      return address.username === "" && address.password === "" && address.hostname !== "";
    case "mailto:":
      return /^mailto:[^\s<>"]+$/.test(value);
    case "tel:":
      return /^tel:\+?[0-9().;=\-A-Za-z]+$/.test(value);
    default:
      return false;
  }
};
