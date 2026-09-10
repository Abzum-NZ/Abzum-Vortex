import { describe, expect, it, test } from "vitest";
import {
  richTextBlockV2Schema as applicationRichTextBlockV2Schema,
  richTextDocumentV2Schema as applicationRichTextDocumentV2Schema,
  richTextElementKindV2Schema as applicationRichTextElementKindV2Schema,
} from "../src/application-composition-v2";
import {
  richTextBlockV2Schema,
  richTextDocumentV2Schema,
  richTextElementKindV2Schema,
} from "../src/rich-text";

describe("shared Page V2 rich-text grammar", () => {
  it("keeps the existing Application composition exports on the shared schema instances", () => {
    expect(applicationRichTextElementKindV2Schema).toBe(richTextElementKindV2Schema);
    expect(applicationRichTextBlockV2Schema).toBe(richTextBlockV2Schema);
    expect(applicationRichTextDocumentV2Schema).toBe(richTextDocumentV2Schema);
  });

  it("accepts the complete existing block and recursive inline grammar", () => {
    expect(
      richTextDocumentV2Schema.safeParse({
        blocks: [
          {
            kind: "paragraph",
            children: [
              { kind: "text", text: "Plain" },
              {
                kind: "emphasis",
                style: "strong",
                children: [
                  {
                    kind: "link",
                    address: "https://example.test/path",
                    children: [{ kind: "text", text: "Linked" }],
                  },
                ],
              },
            ],
          },
          { kind: "heading", level: "2", children: [{ kind: "text", text: "Heading" }] },
          {
            kind: "bulleted_list",
            items: [[{ kind: "text", text: "Bullet" }]],
          },
          {
            kind: "numbered_list",
            items: [[{ kind: "emphasis", style: "code", children: [{ kind: "text", text: "1" }] }]],
          },
        ],
      }).success,
    ).toBe(true);
  });

  test.each([
    ["unknown document property", { blocks: [], html: "<p>Unsafe</p>" }],
    ["empty paragraph", { blocks: [{ kind: "paragraph", children: [] }] }],
    [
      "invalid heading level",
      { blocks: [{ kind: "heading", level: "1", children: [{ kind: "text", text: "Heading" }] }] },
    ],
    ["empty list", { blocks: [{ kind: "bulleted_list", items: [] }] }],
    [
      "unsafe link",
      {
        blocks: [
          {
            kind: "paragraph",
            children: [
              {
                kind: "link",
                address: "javascript:alert(1)",
                children: [{ kind: "text", text: "Unsafe" }],
              },
            ],
          },
        ],
      },
    ],
    ["table widening", { blocks: [{ kind: "table", rows: [] }] }],
    [
      "attachment widening",
      { blocks: [{ kind: "attachment", fileId: "00000000-0000-4000-8000-000000000001" }] },
    ],
  ])("rejects %s", (_name, document) => {
    expect(richTextDocumentV2Schema.safeParse(document).success).toBe(false);
    expect(applicationRichTextDocumentV2Schema.safeParse(document).success).toBe(false);
  });
});
