/** The title when sortable, otherwise the first sortable field in definition order. */
export const defaultRecordOrderField = <Field extends { readonly sortable: boolean }>(
  fields: readonly Field[],
  titleId: string,
  identity: (field: Field) => string,
): Field | undefined => {
  const title = fields.find((field) => identity(field) === titleId);
  return title?.sortable === true ? title : fields.find((field) => field.sortable);
};
