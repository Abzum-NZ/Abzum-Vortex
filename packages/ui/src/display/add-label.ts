/** The add action's label, read from the authored create page's key ("new_contact" -> "Add contact"). */
export const addLabelOf = (pageKey: string): string => {
  const name = pageKey.replace(/^new_/, "").replaceAll("_", " ").trim();
  return name === "" ? "Add" : `Add ${name}`;
};
