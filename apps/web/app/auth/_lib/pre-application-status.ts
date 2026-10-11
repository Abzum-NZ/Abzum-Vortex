import "server-only";

import { identitySessionProxyHeader } from "./session-request-state";

const preApplicationStatusCatalogueVersion: string = "1.0.0";
const preApplicationStatusCode: string = "identity_session_confirmation_unavailable";

const preApplicationStatusCatalogue = Object.freeze({
  version: "1.0.0",
  entries: Object.freeze({
    identity_session_confirmation_unavailable: Object.freeze({
      code: "identity_session_confirmation_unavailable",
      severity: "warning" as const,
      title: "Account access is temporarily unavailable",
      message: "Vortex could not confirm this browser session right now. Try again to continue.",
      linkLabel: "Try again",
      linkBasePath: "/auth/sign-in",
    }),
  }),
});

type CatalogueNotice =
  (typeof preApplicationStatusCatalogue.entries)["identity_session_confirmation_unavailable"];

export type PreApplicationStatusProjection =
  | Readonly<{ kind: "catalogue_notice"; notice: CatalogueNotice }>
  | Readonly<{ kind: "neutral_unavailable" }>;

const neutralUnavailable: PreApplicationStatusProjection = Object.freeze({
  kind: "neutral_unavailable" as const,
});

const lookupCatalogueNotice = (version: string, code: string): CatalogueNotice | undefined => {
  if (version !== preApplicationStatusCatalogue.version || code !== preApplicationStatusCode)
    return undefined;

  const notice = preApplicationStatusCatalogue.entries.identity_session_confirmation_unavailable;
  const linkIndex = notice.message.indexOf(notice.linkLabel);
  if (
    notice.code !== code ||
    notice.linkBasePath !== "/auth/sign-in" ||
    linkIndex < 0 ||
    notice.message.indexOf(notice.linkLabel, linkIndex + notice.linkLabel.length) >= 0
  )
    return undefined;

  return notice;
};

export const projectPreApplicationStatus = (
  requestHeaders: Pick<Headers, "get">,
): PreApplicationStatusProjection => {
  let marker: string | null;
  try {
    marker = requestHeaders.get(identitySessionProxyHeader);
  } catch {
    return neutralUnavailable;
  }
  if (marker !== "temporarily_unavailable") return neutralUnavailable;

  const notice = lookupCatalogueNotice(
    preApplicationStatusCatalogueVersion,
    preApplicationStatusCode,
  );
  return notice === undefined
    ? neutralUnavailable
    : Object.freeze({ kind: "catalogue_notice" as const, notice });
};
