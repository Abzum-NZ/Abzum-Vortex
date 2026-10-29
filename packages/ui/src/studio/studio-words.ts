/** A key as a name a person reads ("primary_foreground" becomes "Primary foreground"). */
export const tokenName = (key: string): string => {
  const words = key
    .trim()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ");
  return words === "" ? key : words[0]!.toUpperCase() + words.slice(1);
};
