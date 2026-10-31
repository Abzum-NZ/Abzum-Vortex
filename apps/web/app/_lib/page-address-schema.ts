import { z } from "zod";

/**
 * The four address segments of one application page, bounded exactly as the address resolver
 * accepts them. Every request that names a page validates its address through this one schema, so
 * one endpoint can never accept an address another refuses.
 */
export const pageAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
  })
  .strict();

export type PageAddress = z.infer<typeof pageAddressSchema>;

/** The page address's search string as one parameter map, keeping every repeated value. */
export const searchParametersOf = (
  search: string,
): Readonly<Record<string, string | readonly string[]>> => {
  const parameters: Record<string, string | readonly string[]> = {};
  for (const [name, value] of new URLSearchParams(search)) {
    const current = parameters[name];
    parameters[name] =
      current === undefined
        ? value
        : typeof current === "string"
          ? [current, value]
          : [...current, value];
  }
  return parameters;
};
