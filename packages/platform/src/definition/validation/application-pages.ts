import { object, failure, array } from "./helpers";
import {
  FORM_CONTAINER_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
} from "../application-composition-catalogue";
import { registeredBlockReleases, type JsonObject } from "./context";
import {
  readRecordsTableContract,
  readRecordDetailContract,
  recordsTableBoardFactsOf,
  calendarMappingSchema,
  calendarBlockSourceIsSupported,
  moduleQueryDefinitionSchema,
  checkRecordsTableFeatures,
  recordsTableEditableFieldTypes,
  type BlockPropertySchemaContract,
  type RecordsTableQueryFacts,
  type RecordsTableRelatedRecordsFacts,
  compiledPageBindingFacts,
  compiledPlacementBindingProblems,
  compiledQueryInputs,
  compiledRecordBindingFields,
} from "../../schema";
import type { ApplicationScope } from "./application-scope";

export function applicationPageRules(scope: ApplicationScope): void {
  const {
    content,
    records,
    pageNavigationPermissionKnown,
    publicPermissionSafe,
    publicActionSafe,
    publicQuerySafe,
    pages,
    collectPlacementEntries,
    pageContentPlacementEntries,
    pageShellPlacementEntries,
    moduleQueries,
    actions,
    output,
    failures,
    walkValues,
  } = scope;

  /**
   * What the compiled release offers a row's related records: each link from another record type
   * to the table's record type, every query with its record type, selected fields and inputs, the
   * row's own fields and the page's binding facts, in canonical identities.
   */
  const relatedRecordsFacts = (
    recordTypeId: string,
    page: RecordsTableRelatedRecordsFacts["page"],
  ): RecordsTableRelatedRecordsFacts => {
    const same = (left: unknown, right: string): boolean =>
      String(left).toLowerCase() === right.toLowerCase();
    const recordList = [...records.values()];
    return {
      recordType: recordTypeId,
      links: recordList.flatMap((record) =>
        array(record.relationships)
          .filter((relationship) =>
            [
              object(relationship.toRecordType ?? {}),
              ...array(relationship.toRecordTypes ?? []),
            ].some((target) => same(target.recordTypeId, recordTypeId)),
          )
          .map((relationship) => {
            const from = array(record.fields).find((field) =>
              same(field.fieldId, String(relationship.fromFieldId)),
            );
            return {
              relationship: String(relationship.relationshipId),
              label: `${String(record.singularLabel)}: ${String(from?.label ?? relationship.key)}`,
              childRecordType: String(record.recordTypeId),
              childRecordTypeLabel: String(record.singularLabel),
            };
          }),
      ),
      queries: [...moduleQueries.values()].map((query) => {
        const queryRecordTypeId = String(object(query.recordType).recordTypeId);
        const record = recordList.find((candidate) =>
          same(candidate.recordTypeId, queryRecordTypeId),
        );
        const selected = new Set(
          array(query.selectedFieldIds).map((id) => String(id).toLowerCase()),
        );
        return {
          query: String(query.queryId),
          label: String(query.label ?? query.key),
          recordType: queryRecordTypeId,
          fields: array(record?.fields)
            .filter((field) => selected.has(String(field.fieldId).toLowerCase()))
            .map((field) => ({ field: String(field.fieldId), label: String(field.label) })),
          inputs: compiledQueryInputs(query),
          grouped: array(query.groupByFieldIds).length > 0 || array(query.aggregates).length > 0,
        };
      }),
      rowFields: compiledRecordBindingFields(
        recordList.find((record) => same(record.recordTypeId, recordTypeId)),
      ),
      page,
    };
  };

  /**
   * What a Records table's bound query offers its grid features, read from the compiled release:
   * each selected field (or grouping field of a grouped query) with its type and flags, the record
   * type's relationships and the named actions whose subject it is.
   */
  const recordsTableQueryFacts = (
    bound: JsonObject,
    page: RecordsTableRelatedRecordsFacts["page"],
  ): RecordsTableQueryFacts => {
    const recordTypeId = String(object(bound.recordType).recordTypeId);
    const record = records.get(recordTypeId);
    const grouped = array(bound.groupByFieldIds).length > 0 || array(bound.aggregates).length > 0;
    const offered = new Set(
      array(grouped ? bound.groupByFieldIds : bound.selectedFieldIds).map((id) =>
        String(id).toLowerCase(),
      ),
    );
    return {
      recordTypeLabel: String(record?.singularLabel ?? ""),
      fields: array(record?.fields)
        .filter((field) => offered.has(String(field.fieldId).toLowerCase()))
        .map((field) => {
          const options = object(field.settings ?? {}).options;
          return {
            field: String(field.fieldId),
            label: String(field.label),
            type: String(field.type),
            sortable: field.sortable === true,
            filterable: field.filterable === true,
            searchable: field.searchPriority !== undefined,
            editable: !grouped && recordsTableEditableFieldTypes.includes(String(field.type)),
            ...(field.type === "choice" && Array.isArray(options)
              ? {
                  choiceCount: options.length,
                  choiceValues: options.map((option) => String(object(option).value)),
                }
              : {}),
            ...(typeof object(field.settings ?? {}).resultType === "string"
              ? { resultType: String(object(field.settings ?? {}).resultType) }
              : {}),
          };
        }),
      unselectedFields: array(record?.fields)
        .filter((field) => !offered.has(String(field.fieldId).toLowerCase()))
        .map((field) => ({ field: String(field.fieldId), label: String(field.label) })),
      relationships: array(record?.relationships).map((relationship) => ({
        key: String(relationship.key),
        label: String(relationship.key),
      })),
      actions: [...actions.values()]
        .filter((action) => String(action.subjectRecordTypeId) === recordTypeId)
        .map((action) => ({
          key: String(action.key),
          label: String(action.label ?? action.key),
          // A run over several records supplies no inputs, so an action that needs one cannot.
          acceptsSelection: array(action.inputs).every((input) => input.required !== true),
        })),
      grouped,
      relatedRecords: relatedRecordsFacts(recordTypeId, page),
      board:
        record === undefined
          ? undefined
          : recordsTableBoardFactsOf(bound, array(record.fields), array(record.pipelines)),
    };
  };

  /**
   * A field reference whose declaration restricts its field types must name a field of one of
   * those types: the Studio picker offers only those, and publication refuses any other.
   */
  const fieldTypesFit = (
    value: JsonObject,
    declaration: BlockPropertySchemaContract,
    fieldType: (fieldId: string) => string | undefined,
  ): boolean => {
    if (value.kind === "field_reference" && declaration.kind === "field_reference")
      return (
        declaration.fieldTypes === undefined ||
        (declaration.fieldTypes as readonly string[]).includes(
          fieldType(String(value.fieldId)) ?? "",
        )
      );
    if (value.kind === "group" && declaration.kind === "group")
      return declaration.properties.every((property) => {
        const nested = object(value.properties)[property.key];
        return nested === undefined || fieldTypesFit(object(nested), property, fieldType);
      });
    if (value.kind === "list" && declaration.kind === "list")
      return array(value.items).every((item) => fieldTypesFit(item, declaration.item, fieldType));
    return true;
  };

  for (const page of pages.values()) {
    const pageRecordId = page.recordType ? String(object(page.recordType).recordTypeId) : undefined;
    const pageQuery = page.queryId ? moduleQueries.get(String(page.queryId)) : undefined;
    const pageQueryRecordId = pageQuery
      ? String(object(pageQuery.recordType).recordTypeId)
      : undefined;
    if (!pageNavigationPermissionKnown(page.accessPermissionKey))
      failures.push(
        failure(output, "vortex.definition.application_page_permission", "broken_reference"),
      );
    if (
      page.queryId &&
      (!pageQuery || (pageRecordId !== undefined && pageQueryRecordId !== pageRecordId))
    )
      failures.push(
        failure(output, "vortex.definition.application_page_query", "broken_reference"),
      );
    const pageRecord = page.recordType ? records.get(pageRecordId!) : undefined;
    if (page.recordType && !pageRecord)
      failures.push(
        failure(output, "vortex.definition.application_page_references", "broken_reference"),
      );
    if (page.type === "guided_form") {
      const controls = pageContentPlacementEntries(page);
      const forms = new Set(
        controls
          .filter(
            ([, placement]) =>
              String(object(placement.vortex.block).blockId) ===
              String(FORM_CONTAINER_BLOCK_RELEASE.blockId),
          )
          .map(([id]) => id.toLowerCase()),
      );
      const flowIds = new Set(
        array(content.flowBindings)
          .filter(
            (binding) =>
              binding.event === "form_submit" && forms.has(String(binding.controlId).toLowerCase()),
          )
          .map((binding) => String(object(binding.flow).flowId)),
      );
      const inputBlocks = new Set([
        String(FIELD_INPUT_BLOCK_RELEASE.blockId),
        ...Object.values(FIELD_INPUT_CONTROL_RELEASES).map((release) => String(release.blockId)),
      ]);
      const fieldKeys = new Set(
        pageRecord ? array(pageRecord.fields).map((field) => String(field.key)) : [],
      );
      const seenFields = new Set<string>();
      let inputMismatch = false;
      for (const [, placement] of controls) {
        if (!inputBlocks.has(String(object(placement.vortex.block).blockId))) continue;
        const candidate = object(placement.settings).name;
        const name = candidate === undefined ? {} : object(candidate);
        const key = name.kind === "text" ? String(name.value) : "";
        if (!fieldKeys.has(key) || seenFields.has(key)) inputMismatch = true;
        seenFields.add(key);
      }
      // The runtime completes a guided form only through exactly one form on the summary step,
      // bound to the page's single completion flow.
      const summaryStep = array(page.steps).find((step) => step.summary === true);
      const composition = object(page.composition);
      const summaryContent = summaryStep
        ? object(composition.stepContent)[String(summaryStep.id)]
        : undefined;
      const summaryPlacements = summaryStep
        ? [...collectPlacementEntries(summaryContent), ...pageShellPlacementEntries(page)]
        : [];
      const summaryForms = new Set(
        summaryPlacements
          .filter(
            ([, placement]) =>
              String(object(placement.vortex.block).blockId) ===
              String(FORM_CONTAINER_BLOCK_RELEASE.blockId),
          )
          .map(([id]) => id.toLowerCase()),
      );
      const summaryFlowIds = new Set(
        array(content.flowBindings)
          .filter(
            (binding) =>
              binding.event === "form_submit" &&
              summaryForms.has(String(binding.controlId).toLowerCase()),
          )
          .map((binding) => String(object(binding.flow).flowId)),
      );
      const summaryBindingValid =
        summaryForms.size === 1 &&
        summaryFlowIds.size === 1 &&
        flowIds.has([...summaryFlowIds][0]!);
      if (forms.size === 0 || flowIds.size !== 1 || !summaryBindingValid || inputMismatch)
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference", {
            kind: "page",
            key: String(page.key),
          }),
        );
    }
    const placementEntries = [
      ...pageContentPlacementEntries(page),
      ...pageShellPlacementEntries(page),
    ];
    const placements = placementEntries.map(([, placement]) => placement);
    const releaseOf = (placement: (typeof placements)[number]) => {
      const block = object(placement.vortex.block);
      return registeredBlockReleases.get(
        `${String(block.blockId)}:${String(block.releaseVersion)}`,
      );
    };
    // Every query-bound block binds each input of its query explicitly, from a source this page
    // offers; publication refuses with the same sentence Studio shows beside the input.
    const bindingFacts = compiledPageBindingFacts(
      page,
      placementEntries,
      releaseOf,
      records,
      moduleQueries,
    );
    for (const problem of bindingFacts.pageProblems)
      failures.push(
        failure(
          output,
          "vortex.definition.application_block_settings",
          "invalid_value",
          undefined,
          "definition_query_binding",
          problem.sentence,
        ),
      );
    // A Records table or Record detail may map only fields its bound Module query selects, and
    // may order only by fields the query can order (a grouped or aggregating query orders by its
    // grouping fields). The default sort must be the query's leading sort, the order the Query
    // engine actually applies. The Query engine refuses a request for an unselected field.
    for (const placement of placements) {
      const bound =
        placement.vortex.queryId === undefined
          ? undefined
          : moduleQueries.get(String(placement.vortex.queryId));
      const block = object(placement.vortex.block);
      const release = registeredBlockReleases.get(
        `${String(block.blockId)}:${String(block.releaseVersion)}`,
      );
      const blockKey = release?.key;
      if (bound === undefined) {
        if (blockKey === "platform.display.calendar")
          failures.push(
            failure(output, "vortex.definition.application_block_settings", "broken_reference"),
          );
        continue;
      }
      const settings = object(placement.settings) as Parameters<typeof readRecordsTableContract>[0];
      for (const problem of compiledPlacementBindingProblems(
        placement,
        release?.name ?? "This block",
        bound,
        bindingFacts,
      ))
        failures.push(
          failure(
            output,
            "vortex.definition.application_block_settings",
            "invalid_value",
            undefined,
            "definition_query_binding",
            problem.sentence,
          ),
        );
      const table = readRecordsTableContract(settings);
      const detail = table === undefined ? readRecordDetailContract(settings) : undefined;
      if (
        blockKey === "platform.display.record_detail" &&
        settings.detail_fields !== undefined &&
        detail === undefined
      )
        failures.push(
          failure(output, "vortex.definition.application_block_settings", "required_value"),
        );
      // A Records table always declares a readable contract: every column with all of its
      // settings (format, width, alignment, responsive priority, default visibility, auto-size,
      // pin position) and a page size.
      if (blockKey === "platform.display.table" && table === undefined)
        failures.push(
          failure(
            output,
            "vortex.definition.application_block_settings",
            "required_value",
            undefined,
            "definition_query_binding",
            `${release?.name ?? "This block"} needs every column to state its format, width, alignment, responsive priority, whether it shows by default and where it is pinned, and a page size`,
          ),
        );
      if (blockKey === "platform.display.calendar") {
        const settingFieldId = (value: unknown): string | undefined => {
          // An optional property the placement leaves out is absent, not an error.
          if (value === undefined) return undefined;
          const property = object(value);
          return property.kind === "field_reference" && typeof property.fieldId === "string"
            ? property.fieldId
            : undefined;
        };
        const settingChoice = (value: unknown): string | undefined => {
          if (value === undefined) return undefined;
          const property = object(value);
          return property.kind === "choice" && typeof property.value === "string"
            ? property.value
            : undefined;
        };
        const mappingProperties = object(object(settings.calendar_mapping).properties);
        const mappingKind = settingChoice(mappingProperties.kind);
        const startFieldId = settingFieldId(mappingProperties.start_field);
        const endFieldId = settingFieldId(mappingProperties.end_field);
        const durationFieldId = settingFieldId(mappingProperties.duration_field);
        const durationUnit = settingChoice(mappingProperties.duration_unit);
        const mappingCandidate =
          mappingKind === "start_end" &&
          startFieldId !== undefined &&
          endFieldId !== undefined &&
          durationFieldId === undefined &&
          durationUnit === undefined
            ? { kind: mappingKind, startFieldId, endFieldId }
            : mappingKind === "start_duration" &&
                startFieldId !== undefined &&
                endFieldId === undefined &&
                durationFieldId !== undefined &&
                durationUnit !== undefined
              ? { kind: mappingKind, startFieldId, durationFieldId, durationUnit }
              : undefined;
        const mapping = calendarMappingSchema.safeParse(mappingCandidate);
        const itemTitleFieldId = settingFieldId(settings.item_title_field);
        const queryRecordType = records.get(String(object(bound.recordType).recordTypeId));
        const fieldById = new Map(
          array(queryRecordType?.fields).map((field) => [
            String(field.fieldId).toLowerCase(),
            field,
          ]),
        );
        const selectedFieldIds = new Set(
          array(bound.selectedFieldIds).map((fieldId) => String(fieldId).toLowerCase()),
        );
        let calendarMappingValid = false;
        if (mapping.success && itemTitleFieldId !== undefined && queryRecordType !== undefined) {
          const startField = fieldById.get(mapping.data.startFieldId.toLowerCase());
          const titleField = fieldById.get(itemTitleFieldId.toLowerCase());
          const dateType = startField?.type;
          const dateFields =
            mapping.data.kind === "start_end"
              ? [startField, fieldById.get(mapping.data.endFieldId.toLowerCase())]
              : [startField];
          const durationField =
            mapping.data.kind === "start_duration"
              ? fieldById.get(mapping.data.durationFieldId.toLowerCase())
              : undefined;
          const durationValid =
            mapping.data.kind !== "start_duration" ||
            ((dateType === "date_time" ||
              (dateType === "date" && mapping.data.durationUnit === "days")) &&
              durationField?.type === "whole_number");
          const mappedFieldIds = [
            mapping.data.startFieldId,
            ...(mapping.data.kind === "start_end"
              ? [mapping.data.endFieldId]
              : [mapping.data.durationFieldId]),
            itemTitleFieldId,
          ];
          calendarMappingValid =
            (dateType === "date" || dateType === "date_time") &&
            dateFields.every(
              (field) =>
                field !== undefined && field.type === dateType && field.filterable === true,
            ) &&
            durationValid &&
            titleField !== undefined &&
            calendarBlockSourceIsSupported(bound, titleField.type) &&
            mappedFieldIds.every((fieldId) => selectedFieldIds.has(fieldId.toLowerCase()));
        }
        if (!calendarMappingValid)
          failures.push(
            failure(output, "vortex.definition.application_block_settings", "broken_reference"),
          );
      }
      if (blockKey === "platform.display.chart") {
        // A chart's categories are the one field its query groups by, and each category is shown as
        // text: a text or choice value, or a link's viewer-safe label.
        const category = settings.category_field as unknown;
        const categoryId =
          category !== undefined &&
          object(category).kind === "field_reference" &&
          typeof object(category).fieldId === "string"
            ? String(object(category).fieldId).toLowerCase()
            : undefined;
        const chartRecordType = records.get(String(object(bound.recordType).recordTypeId));
        const categoryField = array(chartRecordType?.fields).find(
          (field) => String(field.fieldId).toLowerCase() === categoryId,
        );
        const groupedBy = array(bound.groupByFieldIds).map((fieldId) =>
          String(fieldId).toLowerCase(),
        );
        if (
          categoryField === undefined ||
          !["text", "choice", "link"].includes(String(categoryField.type)) ||
          groupedBy.length !== 1 ||
          groupedBy[0] !== categoryId
        )
          failures.push(
            failure(output, "vortex.definition.application_block_settings", "broken_reference"),
          );
      }
      if (table === undefined && detail === undefined) continue;
      if (table !== undefined) {
        if (!moduleQueryDefinitionSchema.safeParse(bound).success)
          failures.push(
            failure(output, "vortex.definition.application_block_settings", "broken_reference"),
          );
        // Every enabled grid feature must fit the bound query; publication reports the feature's
        // own business sentence, the one Studio shows beside its switch.
        for (const feature of checkRecordsTableFeatures(
          table.features,
          recordsTableQueryFacts(bound, bindingFacts),
          table.presentation,
        ))
          // A grid in Board mode shows none of the table's other features, so only the board is judged.
          if (
            feature.enabled &&
            feature.check.kind === "not_possible" &&
            (!table.features.board.enabled || feature.key === "board")
          )
            failures.push(
              failure(
                output,
                "vortex.definition.application_block_settings",
                "unsupported_choice",
                undefined,
                feature.check.code,
                feature.check.reason,
              ),
            );
      }
      if (release !== undefined) {
        const boundRecord = records.get(String(object(bound.recordType).recordTypeId));
        const fieldType = (fieldId: string): string | undefined => {
          const field = array(boundRecord?.fields).find(
            (candidate) => String(candidate.fieldId).toLowerCase() === fieldId.toLowerCase(),
          );
          return field === undefined ? undefined : String(field.type);
        };
        for (const declaration of release.properties) {
          const value = object(settings)[declaration.key];
          if (value !== undefined && !fieldTypesFit(object(value), declaration, fieldType))
            failures.push(
              failure(output, "vortex.definition.application_block_settings", "broken_reference"),
            );
        }
      }
      const lower = (ids: readonly unknown[]): Set<string> =>
        new Set(ids.map((id) => String(id).toLowerCase()));
      const selected = lower(array(bound.selectedFieldIds));
      const grouped = array(bound.groupByFieldIds).length > 0 || array(bound.aggregates).length > 0;
      const orderable = grouped ? lower(array(bound.groupByFieldIds)) : selected;
      const mapped = (fields: readonly string[], allowed: ReadonlySet<string>): boolean =>
        fields.every((field) => allowed.has(field.toLowerCase()));
      // A table in Board mode shows no columns, sort or column filters, so only the Board feature's
      // own check (above) judges its fields; the table's own mappings are not read.
      if (
        (table !== undefined &&
          !table.features.board.enabled &&
          (!mapped(
            table.columns.map((column) => column.field),
            selected,
          ) ||
            // A table never asks for a larger page than its bound query allows.
            table.pageSize > Number(bound.pageSize) ||
            !mapped(table.sortableFields, orderable) ||
            (table.features.columnFilters.enabled &&
              !mapped(table.features.columnFilters.fields, orderable)) ||
            // The authored default order uses only declared sortable fields the query selects.
            !mapped(
              table.defaultSort.map((key) => key.field),
              orderable,
            ) ||
            !mapped(
              table.defaultSort.map((key) => key.field),
              new Set(table.sortableFields.map((field) => field.toLowerCase())),
            ))) ||
        (detail !== undefined &&
          !mapped(
            [
              ...detail.fields.map((entry) => entry.field),
              ...(detail.headingField === undefined ? [] : [detail.headingField]),
            ],
            selected,
          ))
      )
        failures.push(
          failure(output, "vortex.definition.application_block_settings", "broken_reference"),
        );
    }
    if (page.type === "public") {
      const record = page.recordType
        ? records.get(String(object(page.recordType).recordTypeId))
        : undefined;
      const publicFields = new Set(
        record
          ? array(record.fields)
              .filter((field) => field.publicDisplay === "allowed")
              .map((field) => String(field.fieldId))
          : [],
      );
      const pagePublicFields = new Set(page.publicFieldIds as string[]);
      let publicBlockReferencesSafe = true;
      for (const placement of placements) {
        if (
          (placement.vortex.viewPermissionKey !== undefined &&
            !publicPermissionSafe(placement.vortex.viewPermissionKey)) ||
          (placement.vortex.usePermissionKey &&
            !publicPermissionSafe(placement.vortex.usePermissionKey))
        )
          publicBlockReferencesSafe = false;
        walkValues(placement.vortex.visibilityCondition, (entry) => {
          if (entry.source === "field" && !pagePublicFields.has(String(entry.fieldId)))
            publicBlockReferencesSafe = false;
        });
        // A board reads its cards under the viewer's own record access, which a public page has none of.
        if (readRecordsTableContract(object(placement.settings) as never)?.features.board.enabled)
          publicBlockReferencesSafe = false;
        const inspectPublicSetting = (setting: JsonObject) => {
          if (setting.kind === "field_reference" && !pagePublicFields.has(String(setting.fieldId)))
            publicBlockReferencesSafe = false;
          if (setting.kind === "condition")
            walkValues(setting.condition, (entry) => {
              if (entry.source === "field" && !pagePublicFields.has(String(entry.fieldId)))
                publicBlockReferencesSafe = false;
            });
          if (setting.kind === "relationship_reference" || setting.kind === "record_reference")
            publicBlockReferencesSafe = false;
          if (
            setting.kind === "action_reference" &&
            (setting.actionKey !== page.publicActionKey ||
              !publicActionSafe(setting.actionKey, pageRecordId, pagePublicFields))
          )
            publicBlockReferencesSafe = false;
          if (
            setting.kind === "page_reference" &&
            pages.get(String(setting.pageId))?.type !== "public"
          )
            publicBlockReferencesSafe = false;
          if (setting.kind === "query_reference") {
            const query = moduleQueries.get(String(setting.queryId));
            if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
              publicBlockReferencesSafe = false;
          }
        };
        // Each typed setting and every value nested in its groups and lists.
        const inspectTypedSetting = (setting: JsonObject): void => {
          inspectPublicSetting(setting);
          if (setting.kind === "group")
            for (const nested of Object.values(object(setting.properties)))
              inspectTypedSetting(object(nested));
          if (setting.kind === "list")
            for (const item of array(setting.items)) inspectTypedSetting(item);
        };
        for (const setting of Object.values(placement.settings))
          inspectTypedSetting(object(setting));
        if (placement.vortex.queryId) {
          const query = moduleQueries.get(String(placement.vortex.queryId));
          if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
            publicBlockReferencesSafe = false;
        }
      }
      if (
        (page.publicFieldIds as string[]).some((id) => !publicFields.has(id)) ||
        !publicPermissionSafe(page.accessPermissionKey) ||
        (page.queryId &&
          !publicQuerySafe(
            moduleQueries.get(String(page.queryId)),
            pageRecordId,
            pagePublicFields,
          )) ||
        (page.publicActionKey &&
          !publicActionSafe(page.publicActionKey, pageRecordId, pagePublicFields)) ||
        !publicBlockReferencesSafe
      )
        failures.push(
          failure(output, "vortex.definition.application_public_surface", "unsafe_content"),
        );
    }
  }
}
