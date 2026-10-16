/** The module editors the Data tab hosts; each saves the module's own draft, separate from the application. */
export type StudioModuleTool = "fields" | "labels" | "queries" | "before-save" | "publish";
export const studioModuleTools: readonly Readonly<{ value: StudioModuleTool; label: string }>[] = [
  { value: "fields", label: "Fields" },
  { value: "labels", label: "Field labels" },
  { value: "queries", label: "Saved views" },
  { value: "before-save", label: "Rules before saving" },
  { value: "publish", label: "Publish module" },
];

export const isStudioModuleTool = (value: unknown): value is StudioModuleTool =>
  studioModuleTools.some((tool) => tool.value === value);

export type StudioModuleTarget = Readonly<{ organizationId: string; moduleRootId: string; tool: StudioModuleTool }>;
