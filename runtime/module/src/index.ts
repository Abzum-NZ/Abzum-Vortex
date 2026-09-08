import "server-only";

export * from "./storage-provisioning";
export * from "./installation-binding-reader";

export const ModuleService = Object.freeze({
  key: "module",
  boundary: "@vortex/module",
});
