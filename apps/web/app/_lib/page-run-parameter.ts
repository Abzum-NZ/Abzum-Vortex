/**
 * The address parameter, naming a flow, that starts that flow's bound control once the page has opened: the same
 * flow, with the same checks and dialogs, that pressing that control runs. A link into a page
 * (the editor's Publish) uses it, so the page's flow is the only way the action happens.
 */
export const pageRunParameter = "run";

/**
 * The actions of the App Store's application page a link may start: each is the `startFromAddress`
 * token of that page's action binding in Studio's definition, whose flow asks before it changes
 * anything. The editor's Publish and the Studio agent's tool start them this way.
 */
export const appStoreActionTokens = ["publish", "install", "remove", "delete"] as const;
export type AppStoreActionToken = (typeof appStoreActionTokens)[number];
