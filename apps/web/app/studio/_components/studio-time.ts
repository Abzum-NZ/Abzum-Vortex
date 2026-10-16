/** A fixed locale and zone so a server render and the browser hydration print the same text. */
export const formatStudioTimestamp = (iso: string): string =>
  `${new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
