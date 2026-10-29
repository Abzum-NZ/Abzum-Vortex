import { z } from "zod";
import { fileIdSchema, organizationIdSchema } from "../catalogue/identifiers";

const safeDisplayNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value));

const verifiedMediaTypeSchema = z.string().min(1).max(200);

const protectedDownloadHrefSchema = z
  .string()
  .max(96)
  .superRefine((value, context) => {
    const parts = value.split("/");
    if (
      parts.length !== 5 ||
      parts[0] !== "" ||
      parts[1] !== "api" ||
      parts[2] !== "files" ||
      !organizationIdSchema.safeParse(parts[3]).success ||
      !fileIdSchema.safeParse(parts[4]).success
    )
      context.addIssue({
        code: "custom",
        message: "Download links must use the fixed same-origin File route",
      });
  });

/** Safe metadata for one attachment that passed the current protected File read decision. */
export const attachmentListItemSchema = z
  .object({
    displayName: safeDisplayNameSchema,
    mediaType: verifiedMediaTypeSchema,
    sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    downloadHref: protectedDownloadHrefSchema,
  })
  .strict();

/** The strict values consumed by the registered read-only attachment display release. */
export const attachmentListPayloadSchema = z
  .object({
    kind: z.literal("attachment_list"),
    files: z.array(attachmentListItemSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const links = new Set<string>();
    value.files.forEach((file, index) => {
      if (links.has(file.downloadHref))
        context.addIssue({
          code: "custom",
          path: ["files", index, "downloadHref"],
          message: "Attachment links must be unique",
        });
      links.add(file.downloadHref);
    });
  });

export type AttachmentListItem = z.infer<typeof attachmentListItemSchema>;
export type AttachmentListPayload = z.infer<typeof attachmentListPayloadSchema>;
