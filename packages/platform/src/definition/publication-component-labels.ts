const identityPattern = /^(?:[a-z]+(?:[A-Z][a-z]*)*)Id$/;

/**
 * The authored name of every identified component in a compiled definition: any object that carries
 * a `<kind>Id` identity together with a `label` or `name` text. Walks the whole document, so every
 * component kind that is named reads by name without a per-kind list.
 */
export const componentLabelsOf = (
  canonical: unknown,
): ReadonlyArray<Readonly<{ componentId: string; label: string }>> => {
  const labels = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const text = typeof record.label === "string" ? record.label : record.name;
    if (typeof text === "string" && text.trim().length > 0)
      for (const [key, candidate] of Object.entries(record))
        if (key !== "organizationId" && identityPattern.test(key) && typeof candidate === "string" &&
          !labels.has(candidate.toLowerCase()))
          labels.set(candidate.toLowerCase(), text.trim());
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(canonical);
  return [...labels].map(([componentId, label]) => ({ componentId, label }));
};
