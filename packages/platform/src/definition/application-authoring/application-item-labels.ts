import {
  sourceApplicationBodySchema,
  type ApplicationSourceDocument,
} from "../application-source-contracts";
import type { StudioSemanticSelection } from "./semantic-selection";

export type StudioItemLabelResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; issues: readonly Readonly<{ path: string; message: string }>[] }>;

type Navigation = ApplicationSourceDocument["body"]["navigation"];

/**
 * The schema's own rules for each text a label edit sets, so a change is checked where it is
 * made.
 */
const bodyFields = sourceApplicationBodySchema.shape;
const pageName = bodyFields.pages.element.options[0].shape.name;
const shellName = bodyFields.shells.element.shape.name;

/**
 * Menu entries that follow a page's name (their label is the page's old name) take its new
 * name.
 */
const renamedMenuEntries = (
  items: Navigation,
  pageKey: string,
  previous: string,
  next: string,
): Navigation =>
  items.map((item) => {
    if (item.type === "page" && item.page === pageKey && item.label === previous)
      return { ...item, label: next };
    return item.type === "heading"
      ? { ...item, children: renamedMenuEntries(item.children, pageKey, previous, next) }
      : item;
  });

type TextRule = Readonly<{
  safeParse: (value: string) =>
    | Readonly<{ success: true; data: string }>
    | Readonly<{
        success: false;
        error: Readonly<{
          issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[];
        }>;
      }>;
}>;
type Checked =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; issues: readonly Readonly<{ path: string; message: string }>[] }>;

const checked = (schema: TextRule, value: string, path: readonly (string | number)[]): Checked => {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          path: [...path, ...issue.path].join("."),
          message: issue.message,
        })),
      };
};

const invalid = (
  ...results: readonly Checked[]
): Extract<StudioItemLabelResult, { kind: "invalid" }> => ({
  kind: "invalid",
  issues: results.flatMap((result) => (result.ok ? [] : result.issues)),
});

/**
 * The one label edit, behind the inspector's Name and Description fields. A page's menu entries
 * that still carry its name follow the new name. It copies only the path it changes over the
 * frozen draft and checks only the texts it sets with the schema's own field rules, so a keystroke
 * costs no whole-application clone or parse.
 */
export const applyStudioItemLabels = (
  source: ApplicationSourceDocument,
  selection: StudioSemanticSelection | null,
  label: string,
  description: string,
): StudioItemLabelResult => {
  const body = source.body;
  if (selection?.kind === "application") {
    const name = checked(bodyFields.name, label.trim(), ["body", "name"]);
    const text = checked(bodyFields.description, description.trim(), ["body", "description"]);
    if (!name.ok || !text.ok) return invalid(name, text);
    return {
      kind: "applied",
      source: { ...source, body: { ...body, name: name.value, description: text.value } },
    };
  }
  if (selection?.kind === "page") {
    const at = body.pages.findIndex((item) => item.id === selection.pageAlias);
    const page = body.pages[at];
    if (page === undefined) return { kind: "not_found" };
    const name = checked(pageName, label, ["body", "pages", at, "name"]);
    if (!name.ok) return invalid(name);
    const pages = body.pages.map((item, index) =>
      index === at ? { ...item, name: name.value } : item,
    );
    return {
      kind: "applied",
      source: {
        ...source,
        body: {
          ...body,
          pages,
          navigation: renamedMenuEntries(body.navigation, page.key, page.name, name.value),
        },
      },
    };
  }
  if (selection?.kind === "shell") {
    const at = body.shells.findIndex((item) => item.id === selection.shellAlias);
    if (at < 0) return { kind: "not_found" };
    const name = checked(shellName, label, ["body", "shells", at, "name"]);
    if (!name.ok) return invalid(name);
    const shells = body.shells.map((item, index) =>
      index === at ? { ...item, name: name.value } : item,
    );
    return { kind: "applied", source: { ...source, body: { ...body, shells } } };
  }
  return { kind: "not_found" };
};
