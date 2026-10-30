import { pageFlowFormValue, type JsonValue, type PageDefinition } from "@vortex/platform/schema";

type Declarations = NonNullable<PageDefinition["values"]>;

/** The page's declared values, held as slots of its existing flow runtime state. */
export function createPageValueSlots(declarations: Declarations, notify: (key: string) => void) {
  const values = new Map<string, JsonValue>();
  for (const [key, declaration] of Object.entries(declarations))
    values.set(key, declaration.initial);
  return {
    read: (key: string) => values.get(key),
    readTyped: (key: string) => {
      const declaration = declarations[key];
      return declaration === undefined
        ? undefined
        : pageFlowFormValue(declaration.type, values.get(key));
    },
    snapshot: () =>
      Object.fromEntries(
        Object.entries(declarations).map(([key, declaration]) => [
          key,
          { type: declaration.type, value: values.get(key)! },
        ]),
      ),
    write: (updates: Readonly<Record<string, JsonValue>>) => {
      for (const [key, value] of Object.entries(updates)) {
        const declaration = declarations[key];
        if (
          declaration === undefined ||
          pageFlowFormValue(declaration.type, value)?.value !== value ||
          (declaration.type === "json" && value !== null && !Array.isArray(value))
        )
          throw new Error(`FLOW_PAGE_VALUE_INVALID: ${key}`);
      }
      const changed: string[] = [];
      for (const [key, value] of Object.entries(updates)) {
        if (Object.is(values.get(key), value)) continue;
        values.set(key, value);
        changed.push(key);
      }
      changed.forEach(notify);
    },
  };
}
