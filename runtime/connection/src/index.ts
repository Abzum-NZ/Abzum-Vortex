import "server-only";

export const ConnectionService = Object.freeze({
  key: "connection",
  boundary: "@vortex/connection",
});

export * from "./connection-instance-state";
export * from "./connection-readiness";
export * from "./administration";
