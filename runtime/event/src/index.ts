import "server-only";

export * from "./installed-event-occurrence";
export * from "./installed-event-catalogue-source";
export * from "./consumer-progress";
export * from "./delivery-recovery";

export const EventService = Object.freeze({
  key: "event",
  boundary: "@vortex/event",
});
