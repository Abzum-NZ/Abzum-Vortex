import type { ReactElement, ReactNode } from "react";
import { richTextDocumentV2Schema } from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";
import type {
  DisplayRichTextBlock,
  DisplayRichTextDocument,
  DisplayRichTextInline,
} from "./projected-data";

const renderInline = (inline: DisplayRichTextInline, key: number): ReactNode => {
  switch (inline.kind) {
    case "text":
      return inline.text;
    case "emphasis": {
      const children = inline.children.map(renderInline);
      switch (inline.style) {
        case "strong":
          return <strong key={key}>{children}</strong>;
        case "emphasis":
          return <em key={key}>{children}</em>;
        case "code":
          return <code key={key}>{children}</code>;
      }
    }
    case "link":
      return (
        <a key={key} href={inline.address} target="_blank" rel="noopener noreferrer">
          {inline.children.map(renderInline)}
          <span className="vortex-sr-only"> (external link)</span>
        </a>
      );
  }
};

const renderBlock = (block: DisplayRichTextBlock, key: number): ReactNode => {
  switch (block.kind) {
    case "paragraph":
      return <p key={key}>{block.children.map(renderInline)}</p>;
    case "heading": {
      const HeadingTag = `h${block.level}` as "h2" | "h3" | "h4";
      return <HeadingTag key={key}>{block.children.map(renderInline)}</HeadingTag>;
    }
    case "bulleted_list":
      return (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{item.map(renderInline)}</li>
          ))}
        </ul>
      );
    case "numbered_list":
      return (
        <ol key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{item.map(renderInline)}</li>
          ))}
        </ol>
      );
  }
};

/**
 * Renders one validated structured rich-text document as React elements only.
 * The document is re-validated against the shared closed contract at this boundary and any
 * unknown or executable shape fails closed; raw HTML and dangerouslySetInnerHTML are never used.
 */
export function RichTextDocumentView({
  document,
}: Readonly<{ document: DisplayRichTextDocument }>): ReactElement {
  const parsed = richTextDocumentV2Schema.safeParse(document);
  if (!parsed.success) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Rich text content must satisfy the structured rich-text contract",
    );
  }
  const blocks = parsed.data.blocks as readonly DisplayRichTextBlock[];
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>;
}

/** Flattens a validated rich-text document to plain text for accessible labels. */
export function richTextToPlainText(document: DisplayRichTextDocument): string {
  const inlineText = (inline: DisplayRichTextInline): string => {
    switch (inline.kind) {
      case "text":
        return inline.text;
      case "emphasis":
        return inline.children.map(inlineText).join("");
      case "link":
        return inline.children.map(inlineText).join("");
    }
  };
  const blockText = (block: DisplayRichTextBlock): string => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        return block.children.map(inlineText).join("");
      case "bulleted_list":
      case "numbered_list":
        return block.items.map((item) => item.map(inlineText).join("")).join(" ");
    }
  };
  return document.blocks.map(blockText).join(" ");
}
