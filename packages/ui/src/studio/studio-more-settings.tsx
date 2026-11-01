"use client";
import type { ReactElement, ReactNode } from "react";
import { StudioInspectorGroup } from "./studio-inspector-group";

/**
 * Shows the settings of a block in two parts: the ones in use come first, and the optional ones the
 * person has not set sit in a closed "More settings" section below. The caller decides which keys go
 * there once per selected block (so a field does not jump while it is typed into); this only lays
 * the already-built controls out, so every setting stays in the one settings form and its rules.
 */
export function splitMoreSettings(
  controls: readonly Readonly<{ key: string; node: ReactNode }>[],
  moreKeys: ReadonlySet<string> | undefined,
): ReactElement {
  const more = controls.filter((control) => moreKeys?.has(control.key) === true);
  const primary = controls.filter((control) => !more.includes(control));
  return (
    <>
      {primary.map((control) => control.node)}
      {more.length > 0 && (
        <StudioInspectorGroup
          title="More settings"
          defaultOpen={false}
          persist={false}
          summary={`${more.length} more`}
        >
          {more.map((control) => control.node)}
        </StudioInspectorGroup>
      )}
    </>
  );
}
