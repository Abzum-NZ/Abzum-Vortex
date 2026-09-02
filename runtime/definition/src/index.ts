import "server-only";

export const DefinitionService = Object.freeze({
  key: "definition",
  boundary: "@vortex/definition",
});

export * from "./canonical-json";
export * from "./semantic-version";
export * from "./version-impact";
export * from "./version-impact-error";
