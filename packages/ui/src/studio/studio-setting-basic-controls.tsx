"use client";

import { useState, type ReactElement } from "react";
import type { SourceBlockPropertyValueContract } from "@vortex/platform/schema";
import { Input } from "../components/input";
import { StudioReferencePicker } from "./studio-reference-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { Textarea } from "../components/textarea";
import type { ControlProps } from "./studio-setting-model";

/** A number typed as text: the draft is kept while it is not a number, and only a number is reported. */
export function NumberControl({
  id,
  property,
  value,
  onChange,
  disabled,
  descriptionId,
}: ControlProps): ReactElement {
  const current = value?.kind === "number" ? String(value.value) : "";
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setDraft(current);
  }
  const integer = property.kind === "number" && property.integer;
  return (
    <Input
      id={id}
      aria-describedby={descriptionId}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      disabled={disabled}
      value={draft}
      aria-invalid={draft.trim() !== "" && !Number.isFinite(Number(draft))}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() === "") onChange(undefined);
        else if (
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) &&
          Number.isFinite(Number(text))
        )
          onChange({ kind: "number", value: Number(text) });
      }}
    />
  );
}

/**
 * A closed choice among labelled options, with the unset state named by what it means (none when
 * a value is always chosen). Short lists open as a styled list; longer ones are searchable.
 */
export function StudioOptionControl({
  id,
  value,
  options,
  unset,
  disabled,
  onChange,
  "aria-describedby": describedBy,
  "aria-label": label,
  "aria-invalid": invalid,
}: Readonly<{
  id?: string | undefined;
  value: string;
  options: readonly Readonly<{ value: string; label: string; disabled?: boolean | undefined }>[];
  "aria-describedby"?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  unset?: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}>): ReactElement {
  const known = value === "" || options.some((option) => option.value === value);
  if (options.length > 8)
    return (
      <StudioReferencePicker
        id={id}
        value={value}
        options={options}
        unset={unset}
        disabled={disabled}
        onChange={onChange}
        aria-describedby={describedBy}
        aria-label={label}
        aria-invalid={invalid}
      />
    );
  const entries = [
    ...(unset === undefined ? [] : [{ value: "", label: unset, disabled: false }]),
    ...(known ? [] : [{ value, label: "A removed item", disabled: true }]),
    ...options,
  ];
  return (
    <Select
      items={entries.map((entry) => ({ value: entry.value, label: entry.label }))}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid === true || !known}
        disabled={disabled}
      >
        <SelectValue placeholder={unset ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent>
        {entries.map((entry) => (
          <SelectItem key={entry.value} value={entry.value} disabled={entry.disabled}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type RichTextDocument = Extract<SourceBlockPropertyValueContract, { kind: "rich_text" }>["value"];
type RichTextInline = Extract<
  RichTextDocument["blocks"][number],
  { kind: "paragraph" }
>["children"][number];

const inlineWords = (inline: RichTextInline): string =>
  inline.kind === "text" ? inline.text : inline.children.map(inlineWords).join("");

/** The plain words of a rich-text document, one line per paragraph, heading or list item. */
const richTextWords = (document: RichTextDocument): string =>
  document.blocks
    .map((block) =>
      block.kind === "paragraph" || block.kind === "heading"
        ? block.children.map(inlineWords).join("")
        : block.items.map((item) => item.map(inlineWords).join("")).join("\n"),
    )
    .join("\n");

/**
 * Formatted text written as plain paragraphs. The stored document is kept as it is until the
 * person changes the words; an edit stores one paragraph per non-blank line.
 */
export function RichTextControl({ id, value, onChange, disabled }: ControlProps): ReactElement {
  const current = value?.kind === "rich_text" ? richTextWords(value.value) : "";
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setDraft(current);
  }
  return (
    <Textarea
      id={id}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const paragraphs = text
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        onChange(
          paragraphs.length === 0
            ? undefined
            : {
                kind: "rich_text",
                value: {
                  blocks: paragraphs.map((line) => ({
                    kind: "paragraph" as const,
                    children: [{ kind: "text" as const, text: line }],
                  })),
                },
              },
        );
      }}
    />
  );
}

/**
 * A reference to something of this application or of a Module it uses: its own first, then the
 * borrowed ones, which are chosen as they are and changed in their own application.
 */
