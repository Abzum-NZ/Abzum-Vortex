import {
  applicationSourceDocumentSchema,
  applicationUses,
  builderKeySchema,
  describeApplicationUsers,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";

/**
 * The values a page declares (Studio flows design §8): typed, set by flows, shown by displays and
 * read by conditions. A builder adds, changes and removes them in the page's Page values panel. A
 * value that something still uses cannot be removed or have its type changed: the refusal names
 * every user, from the draft's one reference index.
 */

type Page = ApplicationSourceDocument["body"]["pages"][number];
export type StudioPageValueDeclaration = NonNullable<Page["values"]>[string];
export type StudioPageValueType = StudioPageValueDeclaration["type"];

export const studioPageValueTypes: readonly Readonly<{
  type: StudioPageValueType;
  label: string;
}>[] = [
  { type: "decimal_number", label: "Number" },
  { type: "money", label: "Money" },
  { type: "text", label: "Text" },
  { type: "yes_no", label: "Yes or no" },
  { type: "json", label: "List" },
];

export type StudioPageValueCommand =
  | Readonly<{
      kind: "add";
      pageAlias: string;
      name: string;
      label: string;
      type: StudioPageValueType;
      currency?: string;
    }>
  | Readonly<{
      kind: "change";
      pageAlias: string;
      name: string;
      label: string;
      type: StudioPageValueType;
      currency?: string;
    }>
  | Readonly<{ kind: "remove"; pageAlias: string; name: string }>;

export type StudioPageValueResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{
      kind: "refused";
      reason: string;
      /** For a refusal because something uses the value: where. */
      users?: readonly ApplicationUsePlace[];
    }>;

const refused = (reason: string): StudioPageValueResult => ({ kind: "refused", reason });

/** The sentence a refusal gives: the value, then who uses it. */
const usedSentence = (label: string, users: readonly ApplicationUsePlace[]): string =>
  `${label} is used by ${describeApplicationUsers(users)}.`;

export const applyStudioPageValue = (
  source: ApplicationSourceDocument,
  command: StudioPageValueCommand,
): StudioPageValueResult => {
  const candidate = structuredClone(source);
  const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias);
  if (page === undefined) return refused("That page is no longer in the draft. Reload the draft.");
  const values: Record<string, StudioPageValueDeclaration> = { ...page.values };
  if (command.kind === "add") {
    if (!builderKeySchema.safeParse(command.name).success)
      return refused(
        "Name the value with lower-case letters, digits and underscores, starting with a letter.",
      );
    if (Object.hasOwn(values, command.name))
      return refused(`This page already has a value named ${command.name}.`);
    if (command.label.trim() === "") return refused("Give the value a label people can read.");
    if (command.type === "money" && command.currency === undefined)
      return refused("Choose the currency of the money value.");
    values[command.name] = {
      type: command.type,
      label: command.label.trim(),
      initial: null,
      ...(command.type === "money" ? { currency: command.currency } : {}),
    } as StudioPageValueDeclaration;
  } else {
    const held = values[command.name];
    if (held === undefined)
      return refused("That value is no longer on the page. Reload the draft.");
    const users = applicationUses(source, {
      kind: "page_value",
      pageAlias: command.pageAlias,
      name: command.name,
    });
    if (command.kind === "remove") {
      if (users.length > 0)
        return { kind: "refused", reason: usedSentence(held.label, users), users };
      delete values[command.name];
    } else {
      if (command.type !== held.type && users.length > 0)
        return {
          kind: "refused",
          reason: `${usedSentence(held.label, users)} Its type cannot change while they use it.`,
          users,
        };
      if (command.label.trim() === "") return refused("Give the value a label people can read.");
      if (command.type === "money" && command.currency === undefined)
        return refused("Choose the currency of the money value.");
      values[command.name] = {
        type: command.type,
        label: command.label.trim(),
        initial: command.type === held.type ? held.initial : null,
        ...(command.type === "money" ? { currency: command.currency } : {}),
      } as StudioPageValueDeclaration;
    }
  }
  if (Object.keys(values).length === 0) delete page.values;
  else page.values = values;
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refused(first === undefined ? "The page is not valid with this value." : first.message);
  }
  return { kind: "applied", source: parsed.data };
};
