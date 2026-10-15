/**
 * A table's page position in the address: one `page.<placement>` parameter per placement. The
 * value is the direction and the sealed continuation token the table already holds for that page,
 * or `last` for the final page. The token is the account-bound, encrypted cursor and carries no
 * field value; the first page has no parameter.
 */
export type TablePageRequest = Readonly<{
  page: number;
  pageDirection: "forward" | "backward";
  continuationToken?: string;
}>;

const PARAMETER_PREFIX = "page.";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,65536}$/;

export const tablePageParameterName = (placementId: string): string =>
  `${PARAMETER_PREFIX}${placementId}`;

/** True for a parameter that holds one placement's page position. */
export const isTablePageParameter = (name: string): boolean => name.startsWith(PARAMETER_PREFIX);

const PAGE_PATTERN = /^[1-9][0-9]{0,4}$/;

/** The address value for a page request, or undefined for the first page. */
export const encodeTablePagePosition = (request: TablePageRequest): string | undefined => {
  if (request.page <= 1) return undefined;
  if (request.continuationToken === undefined) return `${request.page}.last`;
  return `${request.page}.${request.pageDirection}.${request.continuationToken}`;
};

/**
 * The page request an address value names, `<page>.last` or `<page>.<direction>.<token>`, so the
 * table shows the same page number after a reload; a value that is not a position reads page one.
 */
export const parseTablePagePosition = (value: string | undefined): TablePageRequest | undefined => {
  const [pageText, direction, token, ...rest] = value?.split(".") ?? [];
  if (pageText === undefined || !PAGE_PATTERN.test(pageText) || rest.length > 0) return undefined;
  const page = Number(pageText);
  if (page < 2) return undefined;
  if (direction === "last" && token === undefined) return { page, pageDirection: "backward" };
  if (
    (direction !== "forward" && direction !== "backward") ||
    token === undefined ||
    !TOKEN_PATTERN.test(token)
  )
    return undefined;
  return { page, pageDirection: direction, continuationToken: token };
};

/** The address query without any table page position: what identifies the page itself. */
export const searchWithoutTablePages = (search: string): string => {
  const parameters = new URLSearchParams(search);
  for (const name of [...parameters.keys()]) if (isTablePageParameter(name)) parameters.delete(name);
  return parameters.toString();
};
