import type { ApplicationSourceDocument } from "./application-source-contracts";

/** Every Module an Application builds on: the ones it owns and the ones it uses. */
export const applicationModuleKeys = (application: ApplicationSourceDocument): string[] => [
  ...application.body.modules.map((module) => module.key),
  ...application.body.uses.map((use) => use.module),
];
