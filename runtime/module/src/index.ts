import "server-only";

export * from "./storage-provisioning";
export * from "./installation-binding-reader";
export * from "./installation-lifecycle";
export * from "./index-build-runner";

export const ModuleService = Object.freeze({
  key: "module",
  boundary: "@vortex/module",
});
