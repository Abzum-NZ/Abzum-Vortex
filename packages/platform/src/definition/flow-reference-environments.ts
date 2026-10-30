import { reachablePageFlows } from "../workflows/flow-reachability";
import type { FlowReferenceEnvironment } from "./flow-validation";
import type { ApplicationSourceDocument } from "./definition-source";
import {
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
} from "./application-composition/source-composition";
import {
  CONTROL_BLOCK_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
} from "./application-composition-catalogue";
import type { SourceFlow } from "../workflows/flow-source-contracts";

/**
 * The pages a flow runs on, as its steps may refer to them: for each page of the application that
 * holds a control (or is itself the control) bound to the flow or to a flow that runs it, the
 * page's declared values and the answers each of its forms holds, by type. Publication checks every
 * page and form reference against it, and Studio checks an edit of the flow against the same.
 * `recordFields` answers the field types of a record type by its qualified reference.
 */
export function applicationFlowReferenceEnvironments(
  application: ApplicationSourceDocument["body"],
  flow: SourceFlow,
  flows: readonly SourceFlow[],
  recordFields: (reference: string) => Readonly<Record<string, string>> | undefined,
): readonly FlowReferenceEnvironment[] {
  const controls = new Set(
    application.flow_bindings
      .filter((binding) =>
        reachablePageFlows([binding.flow], flows).some((reachable) => reachable.id === flow.id),
      )
      .map((binding) => binding.control),
  );
  return application.pages.flatMap((page) => {
    const shellAlias = sourcePageShell(page.composition);
    const shell = application.shells.find((candidate) => candidate.id === shellAlias);
    const items = [
      ...sourcePageItems(page.composition),
      ...(shell === undefined ? [] : sourceItemTree(shell.layout.content)),
    ];
    const boundToPage = controls.has(page.id);
    if (!boundToPage && !items.some((item) => controls.has(item.props.id))) return [];
    const forms: Record<string, Readonly<Record<string, string>>> = {};
    const formRestrictions: Record<
      string,
      Record<string, { readOnly: boolean; protectedKind?: "attachment" | "secret" }>
    > = {};
    for (const form of items) {
      if (
        form.props.vortex.block.block_id !== FORM_CONTAINER_BLOCK_RELEASE.blockId ||
        form.props.vortex.block.release_version !== FORM_CONTAINER_BLOCK_RELEASE.releaseVersion
      )
        continue;
      const fields: Record<string, string> = {};
      const restrictions: Record<
        string,
        { readOnly: boolean; protectedKind?: "attachment" | "secret" }
      > = {};
      for (const control of sourceItemTree([form])) {
        const release = CONTROL_BLOCK_RELEASES.find(
          (candidate) => candidate.rendererKey === control.type,
        );
        if (release === undefined) continue;
        const reference = control.props.field;
        const dot = typeof reference === "string" ? reference.lastIndexOf(".") : -1;
        const record =
          dot > 0 && typeof reference === "string"
            ? recordFields(reference.slice(0, dot))
            : undefined;
        const field =
          dot > 0 && typeof reference === "string" ? reference.slice(dot + 1) : undefined;
        const name =
          typeof control.props.name === "string" && control.props.name !== ""
            ? control.props.name
            : field;
        if (name === undefined) continue;
        restrictions[name] = {
          readOnly: control.props.read_only === true,
          ...(release.key === "platform.form.attachment_input"
            ? { protectedKind: "attachment" as const }
            : release.key === "platform.form.connection_secret_input"
              ? { protectedKind: "secret" as const }
              : {}),
        };
        const declared = release.value_type;
        const type =
          record !== undefined && field !== undefined
            ? record[field]
            : declared?.kind === "fixed"
              ? declared.type
              : declared?.kind === "boolean_setting"
                ? control.props[declared.setting] === true
                  ? declared.when_true
                  : declared.when_false
                : undefined;
        if (type !== undefined) fields[name] = type;
      }
      forms[form.props.id] = fields;
      formRestrictions[form.props.id] = restrictions;
    }
    return [
      {
        page: page.name,
        controls: items.filter((item) => controls.has(item.props.id)).map((item) => item.props.id),
        ...(boundToPage ? { pageControl: page.id } : {}),
        values: Object.fromEntries(
          Object.entries(page.values ?? {}).map(([key, value]) => [key, value.type]),
        ),
        forms,
        formRestrictions,
      },
    ];
  });
}
