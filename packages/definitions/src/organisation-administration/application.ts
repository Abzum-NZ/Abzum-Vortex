import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  defaultOpenFlowSource,
  defaultOperationFlowSource,
  defaultSaveFlowSource,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { connectionTypeChoices, organisationAdministrationModules } from "./module";
import { systemDirectoryModule } from "./system-directory";

const organizationSettings = "vortex.organisation_administration:organization_settings";
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
  loadApplicationSource(
    source,
    DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
    [...organisationAdministrationModules, systemDirectoryModule],
    [
      {
        ...defaultOpenFlowSource({
          id: "flow_open_organization_settings",
          key: "open_organization_settings",
          page: "edit_organisation_runtime_settings",
          recordType: organizationSettings,
        }),
        labels: { name: "Open organisation settings" },
      },
      {
        ...defaultSaveFlowSource({
          id: "flow_save_organization_settings_record",
          key: "save_organization_settings_record",
          recordType: organizationSettings,
          mode: "update",
          ownershipMode: "none",
          form: "form_organization_settings",
          after: { kind: "refresh" },
        }),
        labels: { name: "Save organisation settings" },
      },
      {
        ...defaultOpenFlowSource({
          id: "navigate_new_notice",
          key: "navigate_new_notice",
          description: "Opens the organisation notice form.",
          page: "record_organisation_notice",
        }),
        labels: { name: "New notice" },
      },
      {
        ...defaultOpenFlowSource({
          id: "navigate_new_privacy_request",
          key: "navigate_new_privacy_request",
          description: "Opens the privacy request form.",
          page: "record_privacy_request_case",
        }),
        labels: { name: "New privacy request" },
      },
      {
        ...defaultOpenFlowSource({
          id: "flow_open_connection_detail",
          key: "open_connection_detail",
          page: "connection_detail",
          recordType: "vortex.system_directory:connection_instance",
        }),
        labels: { name: "Open connection" },
      },
      {
        ...defaultOperationFlowSource({
          id: "flow_suspend_organization_account",
          key: "suspend_organization_account",
          operation: "platform.suspend_organization_account",
          inputs: {
            organization_account_id: {
              type: "record_reference",
              required: true,
              recordTypeIds: ["vortex.system_directory:person"],
            },
            expected_revision: { type: "whole_number", required: true },
          },
          returnsResult: true,
          done: "Account suspended.",
        }),
        labels: { name: "Suspend organisation account" },
      },
      {
        ...defaultOperationFlowSource({
          id: "flow_reactivate_organization_account",
          key: "reactivate_organization_account",
          operation: "platform.reactivate_organization_account",
          inputs: {
            organization_account_id: {
              type: "record_reference",
              required: true,
              recordTypeIds: ["vortex.system_directory:person"],
            },
            expected_revision: { type: "whole_number", required: true },
          },
          returnsResult: true,
          done: "Account reactivated.",
        }),
        labels: { name: "Reactivate organisation account" },
      },
      {
        ...defaultOperationFlowSource({
          id: "flow_close_organization_account",
          key: "close_organization_account",
          operation: "platform.close_organization_account",
          inputs: {
            organization_account_id: {
              type: "record_reference",
              required: true,
              recordTypeIds: ["vortex.system_directory:person"],
            },
            expected_revision: { type: "whole_number", required: true },
          },
          returnsResult: true,
          done: "Account closed.",
        }),
        labels: { name: "Close organisation account" },
      },
      {
        ...defaultOperationFlowSource({
          id: "flow_revoke_organization_invitation",
          key: "revoke_organization_invitation",
          operation: "platform.revoke_organization_invitation",
          inputs: {
            invitation_id: {
              type: "record_reference",
              required: true,
              recordTypeIds: ["vortex.system_directory:organization_invitation"],
            },
            expected_revision: { type: "whole_number", required: true },
          },
          returnsResult: true,
          done: "Invitation revoked.",
        }),
        labels: { name: "Revoke organisation invitation" },
      },
    ],
  );
