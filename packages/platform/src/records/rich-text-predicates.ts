import { isStableId } from "../catalogue/stable-id";
import { isSafeHttpsUrl, normalizeHttpsUrlText } from "../catalogue/safe-https-url";

export type RichTextInline =
  | { kind: "text"; text: string }
  | { kind: "emphasis"; style: "strong" | "emphasis" | "code"; children: RichTextInline[] }
  | { kind: "link"; address: string; children: RichTextInline[] };

export type RichTextBlock =
  | { kind: "paragraph"; children: RichTextInline[] }
  | { kind: "heading"; level: "2" | "3" | "4"; children: RichTextInline[] }
  | { kind: "bulleted_list" | "numbered_list"; items: RichTextInline[][] };

export type RecordRichTextBlock =
  | RichTextBlock
  | { kind: "table"; rows: { cells: { children: RichTextInline[] }[] }[] }
  | { kind: "file"; fileId: string };

export type RecordRichTextDocument = { blocks: RecordRichTextBlock[] };

const objectWithKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const nonemptyArray = (value: unknown, accepts: (item: unknown) => boolean): boolean => {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value as unknown[]) if (!accepts(item)) return false;
  return true;
};

const inlineAt = (value: unknown, depth: number, insideLink: boolean): value is RichTextInline => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "text")
    return objectWithKeys(item, ["kind", "text"]) && typeof item.text === "string";
  if (depth >= 8) return false;
  if (item.kind === "emphasis")
    return (
      objectWithKeys(item, ["kind", "style", "children"]) &&
      (item.style === "strong" || item.style === "emphasis" || item.style === "code") &&
      nonemptyArray(item.children, (child) => inlineAt(child, depth + 1, insideLink))
    );
  if (item.kind === "link")
    return (
      !insideLink &&
      objectWithKeys(item, ["kind", "address", "children"]) &&
      isSafeHttpsUrl(item.address) &&
      nonemptyArray(item.children, (child) => inlineAt(child, depth + 1, true))
    );
  return false;
};

const isRichTextInline = (value: unknown): value is RichTextInline => inlineAt(value, 1, false);
const inlines = (value: unknown): boolean => nonemptyArray(value, isRichTextInline);

export const isRichTextBlock = (value: unknown): value is RichTextBlock => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "paragraph")
    return objectWithKeys(item, ["kind", "children"]) && inlines(item.children);
  if (item.kind === "heading")
    return (
      objectWithKeys(item, ["kind", "level", "children"]) &&
      (item.level === "2" || item.level === "3" || item.level === "4") &&
      inlines(item.children)
    );
  return (
    (item.kind === "bulleted_list" || item.kind === "numbered_list") &&
    objectWithKeys(item, ["kind", "items"]) &&
    nonemptyArray(item.items, inlines)
  );
};

export const isRecordRichTextBlock = (value: unknown): value is RecordRichTextBlock => {
  if (isRichTextBlock(value)) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "file")
    return objectWithKeys(item, ["kind", "fileId"]) && isStableId(item.fileId);
  return (
    item.kind === "table" &&
    objectWithKeys(item, ["kind", "rows"]) &&
    nonemptyArray(
      item.rows,
      (row) =>
        objectWithKeys(row, ["cells"]) &&
        nonemptyArray(
          row.cells,
          (cell) => objectWithKeys(cell, ["children"]) && inlines(cell.children),
        ),
    )
  );
};

export const isRecordRichTextDocument = (value: unknown): value is RecordRichTextDocument => {
  if (!objectWithKeys(value, ["blocks"]) || !Array.isArray(value.blocks)) return false;
  for (const block of value.blocks as unknown[]) if (!isRecordRichTextBlock(block)) return false;
  return true;
};

const normalizeRichTextInline = (value: RichTextInline): RichTextInline => {
  if (value.kind === "text") return { kind: "text", text: value.text };
  const children = value.children.map(normalizeRichTextInline);
  return value.kind === "link"
    ? { kind: "link", address: normalizeHttpsUrlText(value.address), children }
    : { kind: "emphasis", style: value.style, children };
};

export const normalizeRecordRichTextBlock = (value: RecordRichTextBlock): RecordRichTextBlock => {
  switch (value.kind) {
    case "file":
      return { kind: "file", fileId: value.fileId };
    case "table":
      return {
        kind: "table",
        rows: value.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            children: cell.children.map(normalizeRichTextInline),
          })),
        })),
      };
    case "paragraph":
      return { kind: "paragraph", children: value.children.map(normalizeRichTextInline) };
    case "heading":
      return {
        kind: "heading",
        level: value.level,
        children: value.children.map(normalizeRichTextInline),
      };
    case "bulleted_list":
    case "numbered_list":
      return {
        kind: value.kind,
        items: value.items.map((item) => item.map(normalizeRichTextInline)),
      };
  }
};
