import { isStableId } from "../catalogue/stable-id";
import { isJsonValue, type JsonValue } from "../catalogue/json-value";
import { isCanonicalExactDecimal } from "../records/value-predicates";
import { isRecordRichTextDocument } from "../records/rich-text-predicates";
import { flowInstantMicros } from "./flow-instant";
import { validDate, validText } from "./typed-condition-core";

/** The declared flow value shapes, shared by schema boundaries and the browser interpreter. */
export const flowValueMatchesType = (value: unknown, type: string): value is JsonValue => {
  switch (type) {
    case "text":
      return validText(value);
    case "whole_number":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "decimal_number":
    case "money":
      return isCanonicalExactDecimal(value);
    case "yes_no":
      return typeof value === "boolean";
    case "date":
      return validDate(value);
    case "date_time":
      return flowInstantMicros(value) !== undefined;
    case "organization_account_reference":
      return isStableId(value);
    case "text_collection":
      return Array.isArray(value) && value.every(validText);
    case "opaque_json":
    case "json":
      return isJsonValue(value);
    case "formatted_text":
      return isRecordRichTextDocument(value);
    case "choice":
    case "record_reference":
    case "workflow_run_reference":
    case "relationship_reference":
    case "file_reference":
      return typeof value === "string" && value.length > 0;
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return (
        Array.isArray(value) &&
        value.every((entry: unknown) => typeof entry === "string" && entry.length > 0)
      );
    default:
      return false;
  }
};
