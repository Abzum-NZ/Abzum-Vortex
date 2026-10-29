import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { connectionTypeChoices, organisationAdministrationModule } from "./module";
import { systemDirectoryModule } from "./system-directory";

const source = structuredClone(authoredSource);
const applyConnectionTypeChoices = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(applyConnectionTypeChoices);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.id === "input_create_connection_connection_type_id")
      object.options = connectionTypeChoices;
    Object.values(object).forEach(applyConnectionTypeChoices);
  }
};
applyConnectionTypeChoices(source);

/**
 * Organisation Administration's authored Application source, loaded from JSON. It owns the
 * System Directory Module every other Application that shows people uses.
 */
export const organisationAdministrationApplication: ApplicationSourceDocument =
  loadApplicationSource(source, DEFAULT_SOURCE_APPLICATION_THEME_SELECTION, [
    organisationAdministrationModule,
    systemDirectoryModule,
  ]);
