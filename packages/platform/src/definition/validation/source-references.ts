import {
  type DefinitionRuleFailure,
  type DefinitionValidationLocation,
  builderKeySchema,
} from "../../schema";
import { createContractValueWalker } from "../contract-value-walker";
import {
  type PreparedValidationContext,
  editSaveSources,
  parseEditSaveSource,
  type JsonObject,
} from "./context";
import { object, array } from "./helpers";
import { actionValueReferenceEntry } from "./action-values";
import { sourceTranslationContext } from "./source-paths";
import { moduleDependencies } from "../module-dependencies";

export function sourceLocalReferenceRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, raw] of editSaveSources(context).entries()) {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success) continue;
    const source = parsed.data;
    const walkValues = createContractValueWalker([{ schema: parsed.schema, value: source }]);
    const body = object(source.body);
    let valid = true;
    let invalidLocation: DefinitionValidationLocation | undefined;
    if (source.kind === "module") {
      const records = new Map(
        array(body.record_types).map((record) => [String(record.key), record] as const),
      );
      const derived = moduleDependencies(source);
      const dependencies = new Set(derived.map((dependency) => dependency.module));
      const dependencyKeys = new Set(derived.map((dependency) => dependency.dependency_key));
      const actions = array(body.actions);
      const actionIds = new Set(actions.map((action) => String(action.id)));
      const permissions = new Set(
        array(body.permissions).map((permission) => String(permission.key)),
      );
      const sharingConditions = new Map(
        array(body.sharing_conditions).map((condition) => [String(condition.key), condition]),
      );
      const events = new Set(array(body.events).map((event) => String(event.key)));
      const qualifiedRecordValid = (qualified: unknown): boolean => {
        const value = String(qualified);
        const split = value.lastIndexOf(":");
        if (split < 1) return false;
        const moduleKey = value.slice(0, split);
        const recordKey = value.slice(split + 1);
        return moduleKey === source.key ? records.has(recordKey) : dependencies.has(moduleKey);
      };
      const qualifiedRelationshipValid = (qualified: unknown): boolean => {
        const value = String(qualified);
        const separator = value.lastIndexOf(".");
        if (separator < 1) return false;
        const qualifiedRecord = value.slice(0, separator);
        const relationshipKey = value.slice(separator + 1);
        if (!qualifiedRecordValid(qualifiedRecord)) return false;
        const moduleSeparator = qualifiedRecord.lastIndexOf(":");
        const moduleKey = qualifiedRecord.slice(0, moduleSeparator);
        if (moduleKey !== source.key) return true;
        const record = records.get(qualifiedRecord.slice(moduleSeparator + 1));
        return (
          record !== undefined &&
          array(record.relationships).some(
            (relationship) => String(relationship.key) === relationshipKey,
          )
        );
      };
      const conditionValid = (
        condition: unknown,
        fields: ReadonlySet<string>,
        parameters: ReadonlySet<string> = new Set(),
      ): boolean => {
        const entry = object(condition);
        if (entry.all)
          return array(entry.all).every((child) => conditionValid(child, fields, parameters));
        if (entry.any)
          return array(entry.any).every((child) => conditionValid(child, fields, parameters));
        if (entry.not) return conditionValid(entry.not, fields, parameters);
        if (entry.left) {
          const operandValid = (operandValue: unknown) => {
            const operand = object(operandValue);
            if (operand.source === "field") return fields.has(String(operand.field));
            if (operand.source === "parameter") return parameters.has(String(operand.parameter));
            return operand.source === "value";
          };
          return (
            operandValid(entry.left) && (entry.right === undefined || operandValid(entry.right))
          );
        }
        return (
          fields.has(String(entry.field)) &&
          (entry.parameter === undefined || parameters.has(String(entry.parameter)))
        );
      };
      for (const record of records.values()) {
        const fields = new Set(array(record.fields).map((field) => String(field.key)));
        if (!fields.has(String(record.title_field))) valid = false;
        if ((record.custom_actions as string[]).some((id) => !actionIds.has(id))) valid = false;
        for (const relationship of array(record.relationships)) {
          if (!fields.has(String(relationship.from_field))) valid = false;
          const targets = relationship.to_record_type
            ? [relationship.to_record_type]
            : ((relationship.to_record_types as unknown[] | undefined) ?? []);
          if (targets.some((target) => !qualifiedRecordValid(target))) valid = false;
        }
        for (const field of array(record.fields)) {
          const settings = object(field.settings);
          if (field.type === "link" && !qualifiedRecordValid(settings.target)) valid = false;
          if (
            field.type === "link_to_one_of_several" &&
            (settings.targets as unknown[]).some((target) => !qualifiedRecordValid(target))
          )
            valid = false;
          if (field.type === "calculation") {
            const referenced: string[] = [];
            walkValues(settings.expression, (entry) => {
              for (const [key, candidate] of Object.entries(entry))
                if (key === "field" || key.endsWith("_field")) referenced.push(String(candidate));
              if (Array.isArray(entry.fields)) referenced.push(...entry.fields.map(String));
            });
            if (referenced.some((fieldKey) => !fields.has(fieldKey))) valid = false;
          }
          if (field.type === "total" && !qualifiedRelationshipValid(settings.relationship))
            valid = false;
          if (
            field.type === "table" &&
            array(settings.columns).some((column) => column.settings === undefined)
          )
            valid = false;
          const choiceSettings = [
            ...(["choice", "several_choices"].includes(String(field.type)) ? [settings] : []),
            ...(field.type === "table"
              ? array(settings.columns)
                  .filter((column) => column.type === "choice" && column.settings !== undefined)
                  .map((column) => object(column.settings))
              : []),
          ];
          for (const choice of choiceSettings)
            for (const option of array(choice.options)) {
              if (option.required_permission === undefined) continue;
              const requiredPermission = String(option.required_permission);
              if (
                !permissions.has(requiredPermission) &&
                ![...dependencies].some((dependency) =>
                  requiredPermission.startsWith(`${dependency}.`),
                )
              )
                valid = false;
            }
        }
      }
      for (const permission of array(body.permissions)) {
        if (permission.record_type && !records.has(String(permission.record_type))) valid = false;
        if ((permission.action_kind === "named") !== (permission.named_action !== undefined))
          valid = false;
        const scope = permission.record_scope ? object(permission.record_scope) : undefined;
        for (const route of scope ? array(scope.routes) : []) {
          if (
            route.kind === "ownership" &&
            records.get(String(permission.record_type))?.ownership_mode === "none"
          )
            valid = false;
          if (
            route.kind === "relationship" &&
            (!qualifiedRelationshipValid(route.relationship) ||
              !permissions.has(String(route.source_permission)))
          )
            valid = false;
        }
        const saved = scope?.saved_condition ? object(scope.saved_condition) : undefined;
        if (saved && !sharingConditions.has(String(saved.condition))) valid = false;
      }
      for (const action of actions) {
        const record = records.get(String(action.record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        const relationships = new Set(
          record ? array(record.relationships).map((relationship) => String(relationship.key)) : [],
        );
        const inputs = new Map(
          array(action.inputs).map((input) => [String(input.key), String(input.type)]),
        );
        const actionPermissions =
          action.permission_alternatives === undefined
            ? [String(action.permission)]
            : (action.permission_alternatives as string[]);
        if (
          !record ||
          actionPermissions.length === 0 ||
          actionPermissions.some((key) => !permissions.has(key))
        )
          valid = false;
        if (
          action.precondition &&
          !conditionValid(action.precondition, fields, new Set(inputs.keys()))
        )
          valid = false;
        for (const task of array(action.tasks)) {
          const properties = object(task.properties);
          if (String(task.type) === "record.set_fields")
            for (const field of Object.keys(object(properties.values)))
              if (!fields.has(field)) valid = false;
          if (String(task.type) === "record.changes")
            for (const change of array(properties.changes))
              if (
                ((change.relationships as string[]) ?? []).some((key) => !relationships.has(key)) ||
                inputs.get(String(change.target_input)) !== "record_reference"
              )
                valid = false;
          if (String(task.type) === "event.announce" && !events.has(String(properties.event)))
            valid = false;
          if (
            String(task.type) === "record.create" &&
            !qualifiedRecordValid(properties.record_type)
          )
            valid = false;
          walkValues(task, (entry) => {
            const reference = actionValueReferenceEntry(entry);
            if (
              reference?.source === "input" &&
              !inputs.has(String(reference.name)) &&
              String(reference.name) !== "record"
            )
              valid = false;
            if (reference?.source === "trigger_record" && !fields.has(String(reference.field)))
              valid = false;
          });
        }
      }
      // Task and value references are resolved by the flow compiler and validator; a save rule or
      // reaction of this Module can only be about one of its own record types, or a declared
      // dependency's, written with its definition key.
      for (const flow of array(body.flows))
        for (const trigger of array(flow.triggers))
          if (
            (trigger.type === "BeforeSave" || trigger.type === "Event") &&
            !String(trigger.recordTypeId).includes(":") &&
            !array(body.record_types).some(
              (record) => record.key === trigger.recordTypeId || record.id === trigger.recordTypeId,
            )
          )
            valid = false;
      for (const event of array(body.events)) {
        const record = records.get(String(event.record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        if (!record || (event.carries as string[]).some((field) => !fields.has(field)))
          valid = false;
      }
      for (const point of array(body.extension_points))
        if (!records.has(String(point.record_type))) valid = false;
      for (const contribution of array(body.contributions ?? [])) {
        if (!dependencyKeys.has(String(contribution.dependency))) valid = false;
        if (contribution.kind === "field") {
          const record = records.get(String(contribution.record_type));
          const fields = new Set(
            record ? array(record.fields).map((field) => String(field.key)) : [],
          );
          if (!record || !fields.has(String(contribution.field))) valid = false;
        } else if (!actionIds.has(String(contribution.contributed_action))) valid = false;
      }
      for (const condition of array(body.sharing_conditions)) {
        const record = records.get(String(condition.source_record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        const parameters = new Set(
          array(condition.parameters).map((parameter) => String(parameter.key)),
        );
        if (
          !record ||
          (condition.declared_fields as string[]).some((field) => !fields.has(field)) ||
          !conditionValid(condition.condition, fields, parameters)
        )
          valid = false;
      }
      for (const query of array(body.queries)) {
        // A query names one of this module's own records or a record of a declared dependency.
        // Only an own record can be checked field by field here; a dependency record is resolved
        // against the compiled dependency release by the Module reference rule.
        const authoredRecord = String(query.record_type);
        const separator = authoredRecord.lastIndexOf(":");
        const ownRecordKey =
          separator < 0
            ? authoredRecord
            : authoredRecord.slice(0, separator) === source.key
              ? authoredRecord.slice(separator + 1)
              : undefined;
        if (separator < 0 ? !records.has(authoredRecord) : !qualifiedRecordValid(authoredRecord))
          valid = false;
        const record = ownRecordKey === undefined ? undefined : records.get(ownRecordKey);
        if (record) {
          const fields = new Set(array(record.fields).map((field) => String(field.key)));
          const inputKeys = new Set(array(query.inputs).map((input) => String(input.key)));
          if ((query.select as string[]).some((field) => !fields.has(String(field)))) valid = false;
          if (array(query.group_by).some((field) => !fields.has(String(field)))) valid = false;
          if (array(query.sort).some((sort) => !fields.has(String(sort.field)))) valid = false;
          if (
            array(query.aggregates).some(
              (aggregate) => aggregate.field && !fields.has(String(aggregate.field)),
            )
          )
            valid = false;
          if (query.filter && !conditionValid(query.filter, fields, inputKeys)) valid = false;
        }
      }
    } else if (source.kind === "application") {
      const moduleBindings = new Set([
        ...array(body.modules).map((module) => String(module.key)),
        ...array(body.uses).map((use) => String(use.module)),
      ]);
      const applicationPermissionKeys = new Set(
        array(body.permissions)
          .filter(
            (permission) =>
              permission.action_kind === "named" && permission.record_type === undefined,
          )
          .map((permission) => String(permission.key)),
      );
      const pageGateKnown = (key: unknown) =>
        applicationPermissionKeys.has(String(key)) ||
        context.permissions.hasKey(String(key));
      for (const permission of array(body.permissions)) {
        const scope = permission.record_scope ? object(permission.record_scope) : undefined;
        for (const route of scope ? array(scope.routes) : []) {
          if (route.kind !== "relationship") continue;
          const relationship = String(route.relationship);
          const separator = relationship.lastIndexOf(":");
          if (separator < 1 || !moduleBindings.has(relationship.slice(0, separator))) valid = false;
        }
      }
      const pages = new Set(array(body.pages).map((page) => String(page.key)));
      const flows = new Set(
        array(body.flows).flatMap((flow) => [String(flow.id), String(flow.key)]),
      );
      for (const page of array(body.pages)) {
        if (!pageGateKnown(page.permission)) {
          valid = false;
          const root = sourceTranslationContext(source)?.rootLocation;
          const key = builderKeySchema.safeParse(page.key);
          if (root && key.success)
            invalidLocation ??= {
              ...root,
              segments: [...root.segments, { kind: "page", key: key.data }],
            };
        }
        // A page binds a Module query by "module_key:query_key"; the Module must be bound here.
        if (
          page.query &&
          !moduleBindings.has(String(page.query).slice(0, String(page.query).lastIndexOf(":")))
        )
          valid = false;
      }
      const visitNavigation = (items: JsonObject[]) => {
        for (const item of items) {
          if (
            item.type === "page" &&
            (!pages.has(String(item.page)) || !pageGateKnown(item.permission))
          ) {
            valid = false;
            const root = sourceTranslationContext(source)?.rootLocation;
            const key = builderKeySchema.safeParse(item.id);
            if (root && key.success)
              invalidLocation ??= {
                ...root,
                segments: [...root.segments, { kind: "setting", key: key.data }],
              };
          }
          if (item.type === "heading") visitNavigation(array(item.children));
        }
      };
      visitNavigation(array(body.navigation));
      if (!pages.has(String(body.home_page))) valid = false;
      for (const role of array(body.roles)) if (!pages.has(String(role.home_page))) valid = false;
      for (const definition of array(body.interfaces))
        for (const operation of array(definition.operations)) {
          const target = object(operation.target);
          // A read names a query a bound Module exposes; only the compiled Module releases hold
          // it, so the compiled application validation checks that reference.
          if (target.kind === "flow" && !flows.has(String(target.flow))) valid = false;
        }
      for (const address of array(body.public_addresses))
        if (!pages.has(String(address.page))) valid = false;
    } else {
      const shapeKeys = new Set(array(body.shapes).map((shape) => String(shape.key)));
      const operationKeys = new Set(
        array(body.operations).map((operation) => String(operation.key)),
      );
      for (const operation of array(body.operations))
        if (!shapeKeys.has(String(operation.input)) || !shapeKeys.has(String(operation.output)))
          valid = false;
      for (const message of array(body.incoming_messages))
        if (!shapeKeys.has(String(message.input))) valid = false;
      if (
        [body.health_operation, body.revocation_operation].some(
          (key) => key !== undefined && !operationKeys.has(String(key)),
        )
      )
        valid = false;
    }
    if (!valid)
      failures.push({
        ruleCode: "vortex.definition.local_references",
        family: "broken_reference",
        location: invalidLocation ?? {
          documentKind: source.kind,
          documentKey: source.key,
          segments: [
            {
              kind:
                source.kind === "module"
                  ? "module"
                  : source.kind === "application"
                    ? "application"
                    : "connection",
              key: source.key,
            },
          ],
        },
      });
  }
  return failures;
}
