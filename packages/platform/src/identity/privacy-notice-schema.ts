import { z } from "zod";

export const privacyNoticeContentSchema = z
  .object({
    title: z.string().min(1).max(200),
    collectionNotice: z.string().min(1).max(2000),
    paragraphs: z.array(z.string().min(1).max(10000)).min(1).max(50),
  })
  .strict();

export const privacyNoticePublicationSchema = z
  .object({
    versionLabel: z.string().min(1).max(100),
    effectiveAt: z.iso.datetime(),
    content: privacyNoticeContentSchema,
  })
  .strict();

export const privacyNoticeSchema = privacyNoticePublicationSchema.extend({
  id: z.uuid(),
  locator: z.string().min(1),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type PrivacyNotice = z.infer<typeof privacyNoticeSchema>;
