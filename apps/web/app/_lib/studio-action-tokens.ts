/**
 * The App Store actions the Studio editor and the Studio agent start in place, over the editor: each
 * is the `startableAs` token of that action's binding on the App Store's application page, whose
 * flow asks before it changes anything. They are the one publish and the one install flow, the
 * same ones the page's own buttons run.
 */
export const studioActionTokens = ["publish", "install"] as const;
export type StudioActionToken = (typeof studioActionTokens)[number];
