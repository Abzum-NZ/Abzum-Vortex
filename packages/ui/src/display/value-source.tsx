import {
  compareExactDecimals,
  formatPageValue,
  parseExactDecimal,
  type BlockPropertyValueContract,
  type PageFormatOptions,
} from "@vortex/platform/schema";
import type { ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import { DisplayCellView } from "./cell";
import type { DisplayScalarCell } from "./projected-data";

type Group = Extract<BlockPropertyValueContract, { kind: "group" }>;

const invalid = (): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", "A display value source is invalid");
};

const group = (value: BlockPropertyValueContract | undefined): Group =>
  value?.kind === "group" ? value : invalid();
const string = (value: BlockPropertyValueContract | undefined): string | undefined =>
  value?.kind === "text" || value?.kind === "choice" ? value.value : undefined;

/** Reads the source selected by a display; publication validates its named value and format. */
export const displayValueSource = (value: BlockPropertyValueContract | undefined) => {
  const properties = group(value).properties;
  const source = string(properties.source);
  if (source !== "projection" && source !== "page_value") return invalid();
  return { source, properties } as const;
};

const severityClass = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/** A single display value. The caller supplies only the page slot this item reads. */
export function ValueSourceView({
  source,
  projection,
  pageValue,
}: Readonly<{
  source: ReturnType<typeof displayValueSource>;
  projection?: DisplayScalarCell;
  pageValue?: unknown;
}>): ReactElement {
  if (source.source === "projection") {
    if (projection === undefined) return invalid();
    return <DisplayCellView value={projection} />;
  }
  if (pageValue === undefined) return invalid();
  if (pageValue === null) return <DisplayCellView value={{ kind: "empty" }} />;
  const properties = source.properties;
  const format = string(properties.format);
  let text: string;
  if (format === "plain") {
    const rendered =
      typeof pageValue === "string"
        ? pageValue
        : typeof pageValue === "boolean"
          ? pageValue
            ? "Yes"
            : "No"
          : JSON.stringify(pageValue);
    if (rendered === undefined) return invalid();
    text = rendered;
  } else {
    if (format !== "number" && format !== "money" && format !== "percent" && format !== "unit")
      return invalid();
    const places = properties.places?.kind === "number" ? properties.places.value : undefined;
    const unit = string(properties.unit) as PageFormatOptions["unit"];
    const currency = string(properties.currency);
    if (typeof pageValue !== "string" && typeof pageValue !== "number") return invalid();
    const formatted = formatPageValue(format, pageValue, {
      ...(places === undefined ? {} : { places }),
      ...(unit === undefined ? {} : { unit }),
      ...(currency === undefined ? {} : { currency }),
    });
    if (formatted === undefined) return invalid();
    text = formatted;
  }
  const thresholds = properties.thresholds;
  if (thresholds?.kind !== "list") return invalid();
  const exact = typeof pageValue === "string" ? parseExactDecimal(pageValue) : undefined;
  let severity: keyof typeof severityClass | undefined;
  for (const entry of thresholds.items) {
    const threshold = group(entry).properties;
    const minimum = parseExactDecimal(string(threshold.minimum));
    const candidate = string(threshold.severity);
    if (minimum === undefined || candidate === undefined || !(candidate in severityClass))
      return invalid();
    if (exact !== undefined && compareExactDecimals(exact, minimum) >= 0)
      severity = candidate as keyof typeof severityClass;
  }
  return (
    <span className={severity === undefined ? undefined : severityClass[severity]}>{text}</span>
  );
}
