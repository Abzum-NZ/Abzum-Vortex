import "server-only";

export * from "./installed-event-occurrence";

export const EventService = Object.freeze({
  key: "event",
  boundary: "@vortex/event",
});
