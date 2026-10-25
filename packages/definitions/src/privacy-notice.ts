import { privacyNoticePublicationSchema } from "@vortex/platform/schema";

/** Owner-authorised MADE-UP setting. Replace before any hosted release. */
export const signupPrivacyNoticeSetting = privacyNoticePublicationSchema.parse({
  versionLabel: "MADE-UP v0.1",
  effectiveAt: "2026-10-25T00:00:00.000Z",
  content: {
    title: "Privacy Policy — MADE-UP development placeholder",
    collectionNotice:
      "MADE-UP development notice: Abzum Example Limited collects your email address and password-derived credential to create and protect your account. Read the Privacy Policy before entering your details. Replace these invented facts before any hosted release.",
    paragraphs: [
      "MADE-UP CONTENT — v0.1. This entire notice uses invented company facts and policy text for local development. It is not an approved policy and must be replaced before any hosted release.",
      "MADE-UP collecting entity: Abzum Example Limited, 123 Placeholder Street, Exampletown 0000, New Zealand. MADE-UP privacy contact: Privacy Officer, privacy@example.invalid.",
      "MADE-UP purposes: we use your email address to identify your account and send account verification and recovery messages. The authentication service stores a password-derived credential to protect sign-in. Email and a password are required to register; without them an account cannot be created.",
      "MADE-UP recipients and processing: platform operators and contracted authentication, hosting and email processors process account information to operate the service. Processor identities, locations and overseas handling must be confirmed in the real policy before release.",
      "MADE-UP rights and retention: contact the Privacy Officer to request access to or correction of account information. Account and acknowledgement retention periods, request handling details and security responsibilities must be confirmed in the real policy before release.",
      "Acknowledging this notice records the policy version and time shown at signup. It does not request marketing consent, cookie consent or acceptance of Terms.",
    ],
  },
});
