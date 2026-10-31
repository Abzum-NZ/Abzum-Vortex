/**
 * The add action's label, read from the authored create page's key, the last segment of its
 * address ("/org/app/new_contact" becomes "Add contact").
 */
export const addLabelOf = (href: string): string => {
  const key = decodeURIComponent(href.split("?")[0]!.split("/").pop() ?? "");
  const name = key.replace(/^new_/, "").replaceAll("_", " ").trim();
  return name === "" ? "Add" : `Add ${name}`;
};
