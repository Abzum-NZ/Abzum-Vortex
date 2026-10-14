import type { CSSProperties } from "react";
import type { VortexStyle } from "./vortex-style";
import lumaVariables from "./style-variables/luma.json";
import lyraVariables from "./style-variables/lyra.json";
import maiaVariables from "./style-variables/maia.json";
import miraVariables from "./style-variables/mira.json";
import names from "./style-variables/names.json";
import novaVariables from "./style-variables/nova.json";
import rheaVariables from "./style-variables/rhea.json";
import seraVariables from "./style-variables/sera.json";
import vegaVariables from "./style-variables/vega.json";

/**
 * Shared component values from each pinned shadcn/create style. A root resets the variables first,
 * then receives only the values selected by its own style so nested applications cannot inherit.
 * The tables live in `style-variables/*.json`, one file per style.
 */
const COMPONENT_STYLE_VARIABLE_NAMES: readonly string[] = names;

const COMPONENT_STYLE_VARIABLE_OVERRIDES: Readonly<
  Record<VortexStyle, Readonly<Record<string, string>>>
> = {
  nova: novaVariables,
  vega: vegaVariables,
  maia: maiaVariables,
  lyra: lyraVariables,
  mira: miraVariables,
  luma: lumaVariables,
  sera: seraVariables,
  rhea: rheaVariables,
};

export function createVortexStyleComponentVariables(style: VortexStyle): CSSProperties {
  const variables = Object.fromEntries(
    COMPONENT_STYLE_VARIABLE_NAMES.map((name) => [name, "initial"]),
  );
  return { ...variables, ...COMPONENT_STYLE_VARIABLE_OVERRIDES[style] } as CSSProperties;
}
