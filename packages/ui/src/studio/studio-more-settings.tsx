"use client";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { StudioInspectorGroup } from "./studio-inspector-group";

/**
 * Shows the settings of a block in two parts: the ones in use come first, and the optional ones the
 * person has not set sit in a closed "More settings" section below. The caller decides which keys go
 * there once per selected block (so a field does not jump while it is typed into); this only lays
 * the already-built controls out, so every setting stays in the one settings form and its rules.
 */
export function splitMoreSettings(
  controls: readonly ReactNode[],
  moreKeys: ReadonlySet<string> | undefined,
): ReactElement {
  if (moreKeys === undefined || moreKeys.size === 0) return <>{controls}</>;
  const shown = Children.toArray(controls).filter(isValidElement);
  const more = shown.filter((control) => moreKeys.has(String(control.key).replace(/^\.\$/, "")));
  const primary = shown.filter((control) => !more.includes(control));
  return (
    <>
      {primary}
      {more.length > 0 && (
        <StudioInspectorGroup
          title="More settings"
          defaultOpen={false}
          summary={`${more.length} more`}
        >
          {more}
        </StudioInspectorGroup>
      )}
    </>
  );
}
