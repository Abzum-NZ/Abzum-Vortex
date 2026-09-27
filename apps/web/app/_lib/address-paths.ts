/**
 * The page addresses of the signed-in application routes. Every segment is a candidate short name or
 * key and is encoded, so an address is always built the same way wherever it is linked or redirected.
 */
export const organizationAddressPath = (
  tenantShortName: string,
  organizationShortName: string,
): string => `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}`;

export const applicationPageAddressPath = (
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
  pageKey: string,
): string =>
  `${organizationAddressPath(tenantShortName, organizationShortName)}/${encodeURIComponent(applicationKey)}/${encodeURIComponent(pageKey)}`;
