import "server-only";

export const FileService = Object.freeze({
  key: "file",
  boundary: "@vortex/file",
});

export * from "./file-metadata";
export * from "./storage-policy";
export * from "./content-safety";
export * from "./attachment-authority";
export * from "./storage-credentials";
