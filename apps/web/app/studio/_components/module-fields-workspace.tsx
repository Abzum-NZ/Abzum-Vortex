"use client";
import { useState } from "react";
import type { StoredModuleDefinitionDraft } from "@web/platform-server";
import { ModuleFieldsAgentTools } from "./module-fields-agent-tools";
import { ModuleFieldsEditor } from "./module-fields-editor";
import { ModuleTextFieldSettingsEditor } from "./module-text-field-settings-editor";

/** Holds the one current copy of the Module draft that both field editors save into and read from. */
export function ModuleFieldsWorkspace({ draft }: { draft: StoredModuleDefinitionDraft }) {
  const [current, setCurrent] = useState(draft);
  const [agentWorking, setAgentWorking] = useState(false);
  return <>
    <ModuleFieldsAgentTools draft={current} onDraftChange={setCurrent} onWorkingChange={setAgentWorking} />
    <ModuleFieldsEditor draft={current} onDraftChange={setCurrent} locked={agentWorking} />
    <ModuleTextFieldSettingsEditor draft={current} onDraftChange={setCurrent} locked={agentWorking} />
  </>;
}
