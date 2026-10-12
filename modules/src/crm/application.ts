import {
  sourceApplicationThemeSelectionV2Schema,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";

/**
 * CRM ships its own catalogue selection rather than the platform default, so an installed
 * application's theme is visibly its own: the rounded Maia style, the mauve base and theme colours,
 * violet charts, the large radius and the bold menu accent. Every option is an offered,
 * non-refused catalogue option, and the combination passes the platform contrast and focus checks
 * publication runs.
 */
const selection = sourceApplicationThemeSelectionV2Schema.parse({
  style: "maia",
  base_color: "mauve",
  theme: "mauve",
  chart_color: "violet",
  radius: "large",
  menu_color: "default",
  menu_accent: "bold",
});

type AuthoredCrmSource = {
  body: {
    pages: Array<{
      key: string;
      type: string;
      steps?: unknown;
      composition: {
        shell_kind: string;
        shell: string;
        step_content?: Record<string, Record<string, unknown>>;
        content?: Record<string, unknown>;
      };
    }>;
    flows: Array<{ id: string }>;
    flow_bindings: Array<{ flow: string; event_id: string }>;
    events: Array<{ id: string }>;
  };
};

const source = structuredClone(authoredSource) as unknown as AuthoredCrmSource;
const conversion = source.body.pages.find((page) => page.key === "crm_qualify_lead");
const summary = conversion?.composition.step_content?.page_crm_qualify_summary;
if (!conversion || !summary) throw new Error("CRM conversion form source is missing");
// The conversion action belongs to the final form. Earlier authored steps only showed separate
// forms, and their controls were not lead fields, so they could not form one guided draft.
conversion.type = "form";
delete conversion.steps;
delete conversion.composition.step_content;
conversion.composition.content = summary;
const unusedFlows = new Set(["crm_form_flow_0", "crm_form_flow_1", "crm_form_flow_2"]);
const unusedEvents = new Set(
  source.body.flow_bindings
    .filter((binding) => unusedFlows.has(binding.flow))
    .map((binding) => binding.event_id),
);
source.body.flow_bindings = source.body.flow_bindings.filter(
  (binding) => !unusedFlows.has(binding.flow),
);
source.body.flows = source.body.flows.filter((flow) => !unusedFlows.has(flow.id));
source.body.events = source.body.events.filter((event) => !unusedEvents.has(event.id));

/** CRM's current Application source; all placements use the shared registered block catalogue. */
export const application: ApplicationSourceDocumentV2 = loadApplicationSource(source, selection);
