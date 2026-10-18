/** A record title must be a scalar text/number/date value that can name and sort a record. */
const titleTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "email_address",
  "phone_number",
  "web_address",
  "reference_number",
  "whole_number",
  "decimal_number",
  "choice",
  "date",
  "date_time",
]);

export const recordTitleFieldEligible = (
  field: Readonly<{ type?: unknown; settings?: unknown }>,
): boolean => {
  const settings = field.settings as Record<string, unknown> | undefined;
  if (field.type === "calculation" || field.type === "total")
    return (
      settings?.evaluation !== "read_time" &&
      titleTypes.has(String(settings?.result_type ?? settings?.resultType))
    );
  return titleTypes.has(String(field.type));
};
