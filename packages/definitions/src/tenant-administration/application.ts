import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  defaultOpenFlowSource,
  defaultOperationFlowSource,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { tenantAdministrationModules } from "./module";

/** Tenant Administration's authored Application source, loaded from JSON. */
export const tenantAdministrationApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  tenantAdministrationModules,
  [
    {
      ...defaultOpenFlowSource({
        id: "flow_open_tenant_organization",
        key: "open_tenant_organization",
        page: "tenant_organization_detail",
        recordType: "vortex.system_directory:organization",
      }),
      labels: { name: "Open organisation details" },
    },
    {
      ...defaultOpenFlowSource({
        id: "flow_open_tenant_administrator",
        key: "open_tenant_administrator",
        page: "tenant_administrator_detail",
        recordType: "vortex.system_directory:tenant_administrator",
      }),
      labels: { name: "Open tenant administrator details" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_suspend_tenant_organization",
        key: "suspend_tenant_organization",
        operation: "platform.suspend_tenant_organization",
        inputs: {
          organization_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:organization"],
          },
          expected_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Organisation suspended.",
      }),
      labels: { name: "Suspend organisation" },
    },
    {
      ...defaultOperationFlowSource({
        id: "flow_reactivate_tenant_organization",
        key: "reactivate_tenant_organization",
        operation: "platform.reactivate_tenant_organization",
        inputs: {
          organization_id: {
            type: "record_reference",
            required: true,
            recordTypeIds: ["vortex.system_directory:organization"],
          },
          expected_revision: { type: "whole_number", required: true },
        },
        returnsResult: true,
        done: "Organisation restored.",
      }),
      labels: { name: "Restore organisation" },
    },
  ],
);
