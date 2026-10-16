/**
 * The address key of a preview: `preview.p` followed by the preview installation's identity
 * without dashes. It is a valid Application key that no definition can take, because the
 * `preview` namespace is reserved for it, so a preview is addressed, linked and navigated
 * like an installed Application under its own key.
 */
const previewKeyPattern = /^preview\.p([0-9a-f]{32})$/;

export const previewApplicationKeyNamespace = "preview";

export const previewApplicationKey = (previewInstallationId: string): string =>
  `${previewApplicationKeyNamespace}.p${previewInstallationId.toLowerCase().replaceAll("-", "")}`;

/** The preview installation an Application key addresses, or undefined for any other key. */
export const previewInstallationIdOfApplicationKey = (key: string): string | undefined => {
  const match = previewKeyPattern.exec(key);
  const hex = match?.[1];
  return hex === undefined
    ? undefined
    : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
