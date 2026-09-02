import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const failures = [];
const checks = [];
const fail = (message) => failures.push(message);
const check = (condition, message) => {
  checks.push(message);
  if (!condition) fail(message);
};
const graphCanReach = (edges, from, to) => {
  const outgoing = new Map();
  for (const [edgeFrom, edgeTo] of edges) {
    const targets = outgoing.get(edgeFrom) ?? [];
    targets.push(edgeTo);
    outgoing.set(edgeFrom, targets);
  }
  const pending = [...(outgoing.get(from) ?? [])];
  const visited = new Set();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === to) return true;
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...(outgoing.get(candidate) ?? []));
  }
  return false;
};

check(
  !graphCanReach(
    [
      ["start", "consumer"],
      ["consumer", "future_producer"],
    ],
    "future_producer",
    "consumer",
  ),
  "workflow graph validator rejects an output produced only after its consumer",
);

async function json(path) {
  try {
    return JSON.parse(await readFile(join(root, path), "utf8"));
  } catch (error) {
    fail(`${path}: ${error.message}`);
    return null;
  }
}

async function jsonFiles(directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await jsonFiles(full));
    else if (entry.name.endsWith(".json")) result.push(relative(root, full).replaceAll("\\", "/"));
  }
  return result.sort();
}

const manifest = await json("fixture-set.json");
if (!manifest) process.exit(1);

const actualFiles = (await jsonFiles()).filter((path) => path !== "fixture-set.json");
const listedFiles = [...manifest.files].sort();
check(JSON.stringify(actualFiles) === JSON.stringify(listedFiles), "manifest lists every and only fixture JSON file");

const definitions = new Map();
const roots = new Set();
const sourceByKey = new Map();
for (const path of manifest.files) {
  const value = await json(path);
  if (!value) continue;
  check(value.schema_version === manifest.schema_version, `${path} uses fixture schema version`);
  check(typeof value.key === "string" && value.key.length > 0, `${path} has a key`);
  check(typeof value.root_id === "string" && value.root_id.length > 0, `${path} has a root identity`);
  check(/^\d+\.\d+\.\d+$/.test(value.version), `${path} has a semantic version`);
  check(!definitions.has(value.key), `${path} key is unique`);
  check(!roots.has(value.root_id), `${path} root identity is unique`);
  definitions.set(value.key, value);
  roots.add(value.root_id);
  sourceByKey.set(value.key, path);
}

const modules = new Map([...definitions].filter(([, value]) => value.kind === "module"));
const applications = new Map([...definitions].filter(([, value]) => value.kind === "application"));
const connections = new Map([...definitions].filter(([, value]) => value.kind === "connection_type"));
const scenarios = new Map([...definitions].filter(([, value]) => value.kind === "acceptance_scenario"));
const storageLayouts = new Map([...definitions].filter(([, value]) => value.kind === "storage_layout"));

check(applications.size === 2, "fixture set contains two applications");
check(modules.size === 8, "fixture set contains eight modules");
check(connections.size === 3, "fixture set contains three connection types");
check(scenarios.size === 1, "fixture set contains the cross-application scenario");
check(storageLayouts.size === 1, "fixture set contains one complete storage layout");
check(manifest.applications.every((key) => applications.has(key)), "manifest application keys resolve");

const recordTypes = new Map();
const fields = new Map();
const permissions = new Set();
const actions = new Set();
const actionDefinitions = new Map();
const events = new Set();
const eventDefinitions = new Map();
const fieldTypes = new Set();
const fieldIdentities = new Set();
const storageContracts = new Map();
const requiredFieldKeys = ["id", "key", "type", "label", "required", "unique", "filterable", "sortable", "personal_data", "public_display", "settings"];

for (const [moduleKey, module] of modules) {
  const path = sourceByKey.get(moduleKey);
  for (const dependency of module.body.dependencies ?? []) {
    const target = modules.get(dependency.module);
    check(Boolean(target), `${path} dependency ${dependency.module} resolves`);
    if (target) check(target.version === dependency.version, `${path} dependency ${dependency.module} version resolves exactly`);
  }
  for (const recordType of module.body.record_types ?? []) {
    const full = `${moduleKey}:${recordType.key}`;
    check(!recordTypes.has(full), `${full} is unique`);
    recordTypes.set(full, { moduleKey, recordType });
    check(typeof recordType.storage_contract_id === "string" && /^srt_[a-z0-9_]+$/.test(recordType.storage_contract_id), `${full} has a stable storage contract identity`);
    check(!storageContracts.has(recordType.storage_contract_id), `${full} storage contract identity is unique`);
    storageContracts.set(recordType.storage_contract_id, full);
    check(["organisation_shared", "application_contained"].includes(recordType.storage_scope), `${full} has a valid storage scope`);
    check((recordType.ownership_mode === "inherited") === (typeof recordType.ownership_relationship === "string"), `${full} declares an ownership relationship exactly for inherited ownership`);
    if (recordType.ownership_relationship) check((recordType.fields ?? []).some((field) => field.key === recordType.ownership_relationship && ["link", "link_to_one_of_several"].includes(field.type)), `${full} inherited ownership relationship resolves to a link field`);
    check((recordType.standard_actions ?? []).includes("read"), `${full} supports read`);
    for (const standardAction of recordType.standard_actions ?? []) {
      const key = `${moduleKey}.${recordType.key}.${standardAction}`;
      actions.add(key);
      permissions.add(key);
    }
    for (const field of recordType.fields ?? []) {
      const fullField = `${full}.${field.key}`;
      check(requiredFieldKeys.every((key) => Object.hasOwn(field, key)), `${fullField} declares every required field contract property`);
      check(field.search_priority === undefined || ["first", "normal", "last"].includes(field.search_priority), `${fullField} has a valid optional search priority`);
      check(["none", "personal", "sensitive"].includes(field.personal_data), `${fullField} has a canonical personal-data class`);
      check(["refused", "allowed"].includes(field.public_display), `${fullField} has a canonical public-display choice`);
      if (field.type === "attachment") {
        check(Array.isArray(field.settings.allowed_kinds) && field.settings.allowed_kinds.length > 0, `${fullField} declares canonical allowed file kinds`);
        check(Number.isFinite(field.settings.max_file_size_mb) && field.settings.max_file_size_mb > 0, `${fullField} declares canonical maximum file size`);
        check(typeof field.settings.multiple === "boolean", `${fullField} declares canonical attachment multiplicity`);
        check(field.settings.multiple ? Number.isInteger(field.settings.max_files) && field.settings.max_files > 1 : field.settings.max_files === undefined, `${fullField} declares max_files only for multiple attachments`);
      }
      check(!fields.has(fullField), `${fullField} is unique`);
      check(typeof field.id === "string" && /^[a-z][a-z0-9_]*$/.test(field.id), `${fullField} has a stable SQL-safe field identity`);
      check(!fieldIdentities.has(field.id), `${fullField} field identity is globally unique in the fixture set`);
      fieldIdentities.add(field.id);
      fields.set(fullField, field);
      fieldTypes.add(field.type);
    }
    check((recordType.fields ?? []).some((field) => field.key === recordType.title_field), `${full} title field resolves`);
  }
  for (const permission of module.body.permissions ?? []) permissions.add(permission.key);
  for (const action of module.body.actions ?? []) {
    actions.add(action.key);
    actionDefinitions.set(action.key, action);
    permissions.add(action.permission);
    check(recordTypes.has(`${moduleKey}:${action.record_type}`), `${action.key} record type resolves`);
  }
  for (const event of module.body.events ?? []) {
    events.add(event.key);
    const entry = recordTypes.get(`${moduleKey}:${event.record_type}`);
    eventDefinitions.set(event.key, entry);
    check(Boolean(entry), `${event.key} record type resolves`);
    if (entry) {
      const available = new Set(entry.recordType.fields.map((field) => field.key));
      check((event.carries ?? []).every((field) => available.has(field)), `${event.key} carried fields resolve`);
    }
  }
  for (const rule of module.body.rules ?? []) {
    const subject = recordTypes.get(`${moduleKey}:${rule.record_type}`);
    check(Boolean(subject), `${path} rule ${rule.key} record type resolves`);
    if (!subject) continue;
    const available = new Set(subject.recordType.fields.map((field) => field.key));
    const checkCondition = (condition) => {
      if (condition.field) check(available.has(condition.field), `${path} rule ${rule.key} condition field ${condition.field} resolves`);
      for (const child of condition.all ?? condition.any ?? []) checkCondition(child);
      if (condition.not) checkCondition(condition.not);
    };
    checkCondition(rule.condition);
    if (["set_value", "require"].includes(rule.effect.kind))
      check(available.has(rule.effect.field), `${path} rule ${rule.key} effect field ${rule.effect.field} resolves`);
  }
}

for (const [moduleKey, module] of modules) {
  const path = sourceByKey.get(moduleKey);
  const permittedModules = new Set([
    moduleKey,
    ...(module.body.dependencies ?? []).map((dependency) => dependency.module),
  ]);
  for (const action of module.body.actions ?? []) {
    const subject = recordTypes.get(`${moduleKey}:${action.record_type}`);
    if (!subject) continue;
    const subjectFields = new Set(subject.recordType.fields.map((field) => field.key));
    const subjectRelationships = new Set(
      subject.recordType.fields
        .filter((field) => ["link", "link_to_one_of_several"].includes(field.type))
        .map((field) => field.key),
    );
    const inputTypes = new Map((action.inputs ?? []).map((input) => [input.key, input.type]));
    const checkValue = (value, location) => {
      if (value.source === "input") {
        check(inputTypes.has(value.input), `${path} action ${action.key} ${location} input ${value.input} resolves`);
      }
      if (value.source === "subject_field") {
        check(subjectFields.has(value.field), `${path} action ${action.key} ${location} subject field ${value.field} resolves`);
      }
    };

    for (const effect of action.effects ?? []) {
      if (effect.kind === "set_field") {
        check(subjectFields.has(effect.field), `${path} action ${action.key} set-field target ${effect.field} resolves`);
        checkValue(effect.value, `set-field ${effect.field}`);
      }
      if (effect.kind === "create_record") {
        const target = recordTypes.get(effect.record_type);
        check(Boolean(target), `${path} action ${action.key} create-record target ${effect.record_type} resolves`);
        check(permittedModules.has(effect.record_type.split(":")[0]), `${path} action ${action.key} declares the module that owns ${effect.record_type}`);
        if (target) {
          const targetFields = new Set(target.recordType.fields.map((field) => field.key));
          for (const [field, value] of Object.entries(effect.values ?? {})) {
            check(targetFields.has(field), `${path} action ${action.key} create-record field ${field} resolves`);
            checkValue(value, `create-record field ${field}`);
          }
        }
      }
      if (effect.kind === "copy_relationships") {
        check(["link", "link_to_one_of_several"].includes(inputTypes.get(effect.target_input)), `${path} action ${action.key} relationship-copy target ${effect.target_input} is a link input`);
        check(
          effect.relationships.every((relationship) => subjectRelationships.has(relationship)),
          `${path} action ${action.key} copied relationships resolve to link fields on its subject`,
        );
      }
      if (effect.kind === "announce_event") {
        check(events.has(effect.event), `${path} action ${action.key} event ${effect.event} resolves`);
      }
    }
  }
}

for (const [fullField, field] of fields) {
  const owner = fullField.split(":")[0];
  const dependencies = new Set((modules.get(owner).body.dependencies ?? []).map((item) => item.module));
  dependencies.add(owner);
  const targets = field.type === "link" ? [field.settings.target] : field.type === "link_to_one_of_several" ? field.settings.targets : [];
  for (const target of targets ?? []) {
    check(recordTypes.has(target), `${fullField} target ${target} resolves`);
    const targetModule = target.split(":")[0];
    check(dependencies.has(targetModule), `${fullField} declares dependency on ${targetModule}`);
  }
}

for (const type of manifest.required_field_types) check(fieldTypes.has(type), `field type ${type} is covered`);
check([...fieldTypes].every((type) => manifest.required_field_types.includes(type)), "fixtures use only registered field types");

for (const [connectionKey, connection] of connections) {
  const path = sourceByKey.get(connectionKey);
  const shapes = new Map((connection.body.shapes ?? []).map((shape) => [shape.key, shape]));
  check(shapes.size === connection.body.shapes.length, `${path} connection shape keys are unique`);
  for (const shape of shapes.values()) {
    const fieldKeys = new Set(shape.fields.map((field) => field.key));
    check(fieldKeys.size === shape.fields.length, `${path} shape ${shape.key} field keys are unique`);
  }
  const operationKeys = new Set();
  for (const operation of connection.body.operations ?? []) {
    check(!operationKeys.has(operation.key), `${path} operation ${operation.key} is unique`);
    operationKeys.add(operation.key);
    check(shapes.has(operation.input), `${path} operation ${operation.key} input shape resolves`);
    check(shapes.has(operation.output), `${path} operation ${operation.key} output shape resolves`);
  }
  for (const message of connection.body.incoming_messages ?? [])
    check(shapes.has(message.input), `${path} incoming message ${message.key} input shape resolves`);
  if (connection.body.health_operation)
    check(operationKeys.has(connection.body.health_operation), `${path} health operation resolves`);
  if (connection.body.revocation_operation)
    check(operationKeys.has(connection.body.revocation_operation), `${path} revocation operation resolves`);
}

const workflowTypes = new Set();
const pageTypes = new Set();
const listArrangements = new Set();
for (const [applicationKey, application] of applications) {
  const path = sourceByKey.get(applicationKey);
  const bindingKeys = new Set();
  for (const binding of application.body.module_bindings ?? []) {
    const module = modules.get(binding.module);
    check(Boolean(module), `${path} module binding ${binding.module} resolves`);
    if (module) check(module.version === binding.version, `${path} module binding ${binding.module} version resolves exactly`);
    bindingKeys.add(binding.module);
  }
  const appPermissions = new Set((application.body.permissions ?? []).map((permission) => permission.key));
  for (const key of appPermissions) permissions.add(key);
  const appPages = new Map((application.body.pages ?? []).map((page) => [page.key, page]));
  const appQueries = new Map((application.body.queries ?? []).map((query) => [query.key, query]));
  const appWorkflows = new Map((application.body.workflows ?? []).map((workflow) => [workflow.key, workflow]));
  const appConnections = new Map((application.body.connection_bindings ?? []).map((binding) => [binding.id, binding]));

  check(appPages.has(application.body.home_page), `${path} home page resolves`);
  for (const role of application.body.roles ?? []) {
    check(appPages.has(role.home_page), `${path} role ${role.key} home page resolves`);
    for (const permission of role.permissions ?? []) {
      if (permission.endsWith(".*")) {
        const prefix = permission.slice(0, -1);
        check([...permissions].some((candidate) => candidate.startsWith(prefix)), `${path} role wildcard ${permission} resolves`);
      } else check(permissions.has(permission), `${path} role permission ${permission} resolves`);
    }
  }

  const visitNavigation = (items) => {
    for (const item of items ?? []) {
      if (item.page) check(appPages.has(item.page), `${path} navigation page ${item.page} resolves`);
      if (item.permission) check(permissions.has(item.permission), `${path} navigation permission ${item.permission} resolves`);
      visitNavigation(item.children);
    }
  };
  visitNavigation(application.body.navigation);

  for (const query of appQueries.values()) {
    const entry = recordTypes.get(query.record_type);
    check(Boolean(entry), `${path} query ${query.key} record type resolves`);
    if (entry) {
      check(bindingKeys.has(entry.moduleKey), `${path} query ${query.key} module is bound`);
      const available = new Set(entry.recordType.fields.map((field) => field.key));
      check(query.select.every((field) => available.has(field)), `${path} query ${query.key} selected fields resolve`);
      const checkFilter = (condition) => {
        if (!condition) return;
        if (condition.field) check(available.has(condition.field), `${path} query ${query.key} filter field ${condition.field} resolves`);
        for (const child of condition.all ?? condition.any ?? []) checkFilter(child);
        if (condition.not) checkFilter(condition.not);
      };
      checkFilter(query.filter);
    }
  }

  for (const page of appPages.values()) {
    pageTypes.add(page.type);
    for (const arrangement of page.arrangements ?? []) listArrangements.add(arrangement);
    if (page.record_type) {
      const entry = recordTypes.get(page.record_type);
      check(Boolean(entry), `${path} page ${page.key} record type resolves`);
      if (entry) check(bindingKeys.has(entry.moduleKey), `${path} page ${page.key} module is bound`);
      if (entry && page.type === "list") {
        const usesCalendar = (page.arrangements ?? []).includes("calendar");
        check(usesCalendar === Boolean(page.calendar_mapping), `${path} page ${page.key} has a calendar mapping exactly when calendar is enabled`);
        if (page.calendar_mapping) {
          const availableFields = new Map(entry.recordType.fields.map((field) => [field.key, field]));
          check(availableFields.has(page.calendar_mapping.start), `${path} page ${page.key} calendar start field resolves`);
          if (page.calendar_mapping.end) check(availableFields.has(page.calendar_mapping.end), `${path} page ${page.key} calendar end field resolves`);
          if (page.calendar_mapping.duration_field) check(availableFields.get(page.calendar_mapping.duration_field)?.type === "whole_number", `${path} page ${page.key} calendar duration resolves to a whole-number field`);
          check(Boolean(page.calendar_mapping.end) !== Boolean(page.calendar_mapping.duration_field), `${path} page ${page.key} calendar uses exactly an end field or duration field`);
          check(Boolean(page.calendar_mapping.duration_field) === Boolean(page.calendar_mapping.duration_unit), `${path} page ${page.key} calendar duration unit appears exactly with a duration field`);
        }
      }
    }
    if (page.query) check(appQueries.has(page.query), `${path} page ${page.key} query resolves`);
    if (page.permission) check(permissions.has(page.permission), `${path} page ${page.key} permission resolves`);
    if (page.commit_action) check(actions.has(page.commit_action), `${path} page ${page.key} action resolves`);
    check((page.states ?? []).includes("loading"), `${path} page ${page.key} has a loading state`);
  }

  for (const workflow of appWorkflows.values()) {
    const triggerRecordType = workflow.trigger.event
      ? eventDefinitions.get(workflow.trigger.event)
      : undefined;
    if (workflow.trigger.event)
      check(Boolean(triggerRecordType), `${path} workflow ${workflow.key} event resolves`);
    const triggerFieldKeys = new Set(
      triggerRecordType?.recordType.fields.map((field) => field.key) ?? [],
    );
    const triggerQualifiedFields = new Set(
      triggerRecordType?.recordType.fields.map(
        (field) => `${triggerRecordType.moduleKey}:${triggerRecordType.recordType.key}.${field.key}`,
      ) ?? [],
    );
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
    const fixedOutputs = new Map([
      ["create_record", new Set(["record"])],
      ["change_record", new Set(["record"])],
      ["duplicate_record", new Set(["record"])],
      ["query_records", new Set(["records"])],
      ["set_values", new Set(["record"])],
      ["format_value", new Set(["value"])],
      ["generate_export", new Set(["file"])],
      ["call_connection", new Set(["response"])],
    ]);
    const checkWorkflowValue = (value, location, consumerNodeId) => {
      if (value.source === "trigger_field")
        check(
          triggerQualifiedFields.has(value.field),
          `${path} workflow ${workflow.key} ${location} trigger field ${value.field} belongs to its triggering record type`,
        );
      if (value.source === "current_record")
        check(
          Boolean(triggerRecordType),
          `${path} workflow ${workflow.key} ${location} current record has a record-bearing event trigger`,
        );
      if (value.source === "node_output") {
        const sourceNode = nodesById.get(value.node);
        check(Boolean(sourceNode), `${path} workflow ${workflow.key} ${location} source node ${value.node} resolves`);
        if (!sourceNode) return;
        check(
          graphCanReach(workflow.edges, sourceNode.id, consumerNodeId),
          `${path} workflow ${workflow.key} ${location} source node ${value.node} can precede ${consumerNodeId}`,
        );
        if (sourceNode.type === "request_form") {
          const page = appPages.get(sourceNode.config.page);
          const recordType = page?.record_type ? recordTypes.get(page.record_type) : undefined;
          const commitAction = page?.commit_action ? actionDefinitions.get(page.commit_action) : undefined;
          check(
            Boolean(
              recordType?.recordType.fields.some((field) => field.key === value.output) ||
                commitAction?.inputs.some((input) => input.key === value.output),
            ),
            `${path} workflow ${workflow.key} ${location} form output ${value.output} resolves`,
          );
        } else {
          check(Boolean(fixedOutputs.get(sourceNode.type)?.has(value.output)), `${path} workflow ${workflow.key} ${location} output ${value.output} is declared by ${sourceNode.type}`);
        }
      }
    };
    for (const node of workflow.nodes) {
      workflowTypes.add(node.type);
      check(manifest.required_workflow_nodes.includes(node.type), `${path} workflow ${workflow.key} node ${node.type} is registered`);
      if (node.config.action) {
        check(actions.has(node.config.action), `${path} workflow ${workflow.key} action ${node.config.action} resolves`);
        const action = actionDefinitions.get(node.config.action);
        if (action) {
          const supplied = new Set(Object.keys(node.config.inputs ?? {}));
          check((action.inputs ?? []).filter((input) => input.required).every((input) => supplied.has(input.key)), `${path} workflow ${workflow.key} action ${node.config.action} supplies every required input`);
          check([...supplied].every((key) => (action.inputs ?? []).some((input) => input.key === key)), `${path} workflow ${workflow.key} action ${node.config.action} input keys resolve`);
        }
        for (const [key, value] of Object.entries(node.config.inputs ?? {}))
          checkWorkflowValue(value, `action input ${key}`, node.id);
      }
      if (node.config.query) check(appQueries.has(node.config.query), `${path} workflow ${workflow.key} query ${node.config.query} resolves`);
      if (node.config.page) check(appPages.has(node.config.page), `${path} workflow ${workflow.key} page ${node.config.page} resolves`);
      if (node.config.workflow) check(appWorkflows.has(node.config.workflow), `${path} workflow ${workflow.key} child workflow ${node.config.workflow} resolves`);
      if (node.config.record_type) {
        const target = recordTypes.get(node.config.record_type);
        check(Boolean(target), `${path} workflow ${workflow.key} record type ${node.config.record_type} resolves`);
        if (target && node.config.values) {
          const available = new Set(target.recordType.fields.map((field) => field.key));
          check(Object.keys(node.config.values).every((field) => available.has(field)), `${path} workflow ${workflow.key} ${node.type} value fields resolve`);
          for (const [field, value] of Object.entries(node.config.values))
            checkWorkflowValue(value, `${node.type} field ${field}`, node.id);
        }
      }
      if (node.type === "set_values") {
        for (const [field, value] of Object.entries(node.config.values)) {
          check(fields.has(field), `${path} workflow ${workflow.key} set-value field ${field} resolves`);
          checkWorkflowValue(value, `set-value field ${field}`, node.id);
        }
      }
      if (node.type === "condition")
        check(
          triggerFieldKeys.has(node.config.field),
          `${path} workflow ${workflow.key} condition ${node.id} field ${node.config.field} belongs to its triggering record type`,
        );
      if (node.type === "decision_table") {
        const checkDecisionCondition = (condition) => {
          if (condition.field)
            check(
              triggerFieldKeys.has(condition.field),
              `${path} workflow ${workflow.key} decision ${node.id} field ${condition.field} belongs to its triggering record type`,
            );
          for (const child of condition.all ?? condition.any ?? []) checkDecisionCondition(child);
          if (condition.not) checkDecisionCondition(condition.not);
        };
        for (const decision of node.config.decisions) checkDecisionCondition(decision.when);
      }
      if (node.type === "format_value")
        checkWorkflowValue(node.config.input, "format input", node.id);
      for (const key of ["record", "subject", "target", "source_record", "target_record"])
        if (node.config[key])
          checkWorkflowValue(node.config[key], `${node.type} ${key}`, node.id);
      if (["add_relationship", "copy_relationships"].includes(node.type)) {
        const relationships = node.type === "add_relationship" ? [node.config.relationship] : node.config.relationships;
        check(relationships.every((field) => ["link", "link_to_one_of_several"].includes(fields.get(field)?.type)), `${path} workflow ${workflow.key} ${node.type} relationships resolve`);
      }
      if (["attach_file", "move_file"].includes(node.type)) {
        check(fields.get(node.config.field)?.type === "attachment", `${path} workflow ${workflow.key} ${node.type} field resolves to an attachment`);
        checkWorkflowValue(node.config.file, `${node.type} file`, node.id);
      }
      if (node.type === "wait_until")
        check(["date", "date_time"].includes(fields.get(node.config.field)?.type), `${path} workflow ${workflow.key} wait field resolves to a date or date-time`);
      if (node.config.connection) {
        const binding = appConnections.get(node.config.connection);
        check(Boolean(binding), `${path} workflow ${workflow.key} connection ${node.config.connection} resolves`);
        if (binding) {
          check(binding.required_operations.includes(node.config.operation), `${path} workflow ${workflow.key} connection operation ${node.config.operation} is bound`);
          const connectionType = connections.get(binding.connection_type);
          const operation = connectionType?.body.operations.find(
            (candidate) => candidate.key === node.config.operation,
          );
          const inputShape = connectionType?.body.shapes.find(
            (shape) => shape.key === operation?.input,
          );
          check(Boolean(operation), `${path} workflow ${workflow.key} connection operation ${node.config.operation} resolves`);
          check(Boolean(inputShape), `${path} workflow ${workflow.key} connection input shape resolves`);
          if (inputShape) {
            const supplied = new Set(Object.keys(node.config.inputs));
            check(
              inputShape.fields
                .filter((field) => field.required)
                .every((field) => supplied.has(field.key)),
              `${path} workflow ${workflow.key} connection call supplies every required input`,
            );
            check(
              [...supplied].every((key) => inputShape.fields.some((field) => field.key === key)),
              `${path} workflow ${workflow.key} connection call supplies only declared inputs`,
            );
            for (const [key, value] of Object.entries(node.config.inputs))
              checkWorkflowValue(value, `connection input ${key}`, node.id);
          }
        }
      }
    }
    for (const [from, to] of workflow.edges) check(nodeIds.has(from) && nodeIds.has(to), `${path} workflow ${workflow.key} edge ${from}->${to} resolves`);
    for (const node of workflow.nodes) {
      const outcomes = new Set(workflow.edges.filter(([from]) => from === node.id).map(([, , outcome]) => outcome).filter(Boolean));
      if (node.type === "condition") check(["matched", "not_matched"].every((outcome) => outcomes.has(outcome)), `${path} workflow ${workflow.key} condition ${node.id} routes matched and not_matched`);
      if (node.type === "decision_table") check(node.config.decisions.every((decision) => outcomes.has(decision.output)), `${path} workflow ${workflow.key} decision ${node.id} routes every output`);
      if (node.type === "bounded_loop") check(["record", "completed"].every((outcome) => outcomes.has(outcome)), `${path} workflow ${workflow.key} loop ${node.id} routes record and completed`);
      if (node.type === "request_form") check(["submitted", node.config.timeout_outcome].every((outcome) => outcomes.has(outcome)), `${path} workflow ${workflow.key} form ${node.id} routes submitted and timeout`);
    }
  }

  for (const pipeline of application.body.pipelines ?? []) {
    const entry = recordTypes.get(pipeline.record_type);
    check(Boolean(entry), `${path} pipeline ${pipeline.key} record type resolves`);
    if (entry) check(entry.recordType.fields.some((field) => field.key === pipeline.stage_field && field.type === "choice"), `${path} pipeline ${pipeline.key} stage field resolves to a choice`);
    const stageKeys = new Set(pipeline.stages.map((stage) => stage.key));
    for (const stage of pipeline.stages) {
      for (const action of [...(stage.entry_actions ?? []), ...(stage.exit_actions ?? [])])
        check(actions.has(action), `${path} pipeline ${pipeline.key} stage action ${action} resolves`);
      for (const workflowKey of [
        ...(stage.entry_workflows ?? []),
        ...(stage.exit_workflows ?? []),
      ])
        check(appWorkflows.has(workflowKey), `${path} pipeline ${pipeline.key} stage workflow ${workflowKey} resolves`);
    }
    for (const transition of pipeline.transitions) {
      check(stageKeys.has(transition.from) && stageKeys.has(transition.to), `${path} pipeline ${pipeline.key} transition stages resolve`);
      if (transition.action) check(actions.has(transition.action), `${path} pipeline ${pipeline.key} action ${transition.action} resolves`);
      if (transition.permission) check(permissions.has(transition.permission), `${path} pipeline ${pipeline.key} permission ${transition.permission} resolves`);
    }
    for (const target of pipeline.time_targets) {
      check(stageKeys.has(target.stage), `${path} pipeline ${pipeline.key} time-target stage resolves`);
      check(entry?.recordType.fields.some((field) => field.key === target.field && field.type === "date_time"), `${path} pipeline ${pipeline.key} time-target field resolves to date-time`);
      check(events.has(target.escalation_event), `${path} pipeline ${pipeline.key} escalation event resolves`);
    }
  }

  for (const binding of appConnections.values()) {
    const type = connections.get(binding.connection_type);
    check(Boolean(type), `${path} connection type ${binding.connection_type} resolves`);
    if (type) {
      const operations = new Set((type.body.operations ?? []).map((operation) => operation.key));
      check(binding.required_operations.every((operation) => operations.has(operation)), `${path} connection ${binding.id} operations resolve`);
    }
  }

  for (const iface of application.body.interfaces ?? []) {
    check(/^\d+\.\d+\.\d+$/.test(iface.version), `${path} interface ${iface.key} is versioned`);
    for (const operation of iface.operations ?? []) {
      if (operation.query) check(appQueries.has(operation.query), `${path} interface query ${operation.query} resolves`);
      if (operation.action) check(actions.has(operation.action), `${path} interface action ${operation.action} resolves`);
      check(permissions.has(operation.permission), `${path} interface permission ${operation.permission} resolves`);
    }
  }
}

for (const type of manifest.required_workflow_nodes) check(workflowTypes.has(type), `workflow node type ${type} is covered`);
for (const type of ["list", "detail", "dashboard", "form", "guided_form", "public"]) check(pageTypes.has(type), `page type ${type} is covered`);
for (const arrangement of ["table", "board", "calendar", "summary"]) check(listArrangements.has(arrangement), `list arrangement ${arrangement} is covered`);

for (const item of manifest.required_cross_application_cases) {
  const full = `${item.module}:${item.record_type}`;
  check(recordTypes.has(full), `cross-application record type ${full} resolves`);
  const appKeys = item.applications ?? [item.source_application, item.recipient_application];
  for (const key of appKeys) {
    const app = applications.get(key);
    check(Boolean(app), `cross-application app ${key} resolves`);
    if (app) check(app.body.module_bindings.some((binding) => binding.module === item.module), `${key} binds ${item.module}`);
  }
}

const scenario = scenarios.get("vortex.scenario.cross_application_sharing");
check(Boolean(scenario), "cross-application scenario key resolves");
if (scenario) {
  const grant = scenario.body.inter_application_grant;
  const entry = recordTypes.get(`${grant.module}:${grant.record_type}`);
  check(Boolean(entry), "scenario grant record type resolves");
  if (entry) {
    const available = new Set(entry.recordType.fields.map((field) => field.key));
    check(grant.readable_fields.every((field) => available.has(field)), "scenario readable fields resolve");
    check(grant.changeable_fields.every((field) => grant.readable_fields.includes(field)), "scenario changeable fields are readable");
  }
  check(grant.allowed_actions.every((action) => actions.has(action)), "scenario allowed actions resolve");
  check(grant.allowed_actions.every((key) => {
    for (const module of modules.values()) {
      const action = (module.body.actions ?? []).find((candidate) => candidate.key === key);
      if (action) return action.shareable === true;
    }
    return false;
  }), "scenario actions are published as shareable");
  check(grant.export_allowed === false, "fixture case export is refused");
  check(grant.expected_physical_records === 1, "fixture case remains one source record");
  check(JSON.stringify(grant.readable_fields) === JSON.stringify(["case_number", "subject", "status", "priority", "customer_company", "resolved_at"]), "CRM receives exactly the approved limited Case Summary fields");
  check(JSON.stringify(grant.changeable_fields) === JSON.stringify(["status", "priority"]), "CRM collaboration is limited to approved case fields");
  check(JSON.stringify(grant.allowed_actions) === JSON.stringify(["vortex.service_desk.cases.case.add_public_comment"]), "CRM collaboration is limited to the approved public-comment action");
  const assertionOutcomes = new Set((scenario.body.assertions ?? []).map((assertion) => assertion.expect));
  check(assertionOutcomes.has("same_record_id_and_current_values"), "scenario proves Company and Contact remain the same source records");
  check(assertionOutcomes.has("source_case_saved_once_and_visible_in_both_applications"), "scenario proves collaborative changes update the one source case");
  check(assertionOutcomes.has("next_access_check_removes_rendered_values_and_cache_cannot_restore_them"), "scenario proves immediate grant revocation without a recipient copy");
}

const storageLayout = storageLayouts.get("vortex.storage.complete_examples");
check(Boolean(storageLayout), "complete storage layout key resolves");
if (storageLayout) {
  const body = storageLayout.body;
  check(body.owning_service === "record", "storage layout is owned by the Record service");
  check(body.physical_schema === "record_data", "storage layout uses the protected record schema");
  check(body.allocation_unit === "storage_contract_id", "tables are allocated by storage lineage rather than app or organisation");
  check(body.uses_display_names === false, "physical names never use display names");
  check(JSON.stringify(body.scope_keys?.organisation_shared) === JSON.stringify(["organisation_id"]), "organisation-shared scope key is exact");
  check(JSON.stringify(body.scope_keys?.application_contained) === JSON.stringify(["organisation_id", "application_root_id"]), "application-contained scope key is exact");

  const requiredSystemColumns = [
    "organisation_id", "module_root_id", "record_type_id", "storage_contract_id", "record_id",
    "application_root_id", "definition_revision", "owner_organisation_account_id", "owner_team_id", "lifecycle_state",
    "concurrency_number", "created_at", "created_by", "updated_at", "updated_by", "deleted_at",
    "deleted_by", "removal_due_at"
  ];
  check(JSON.stringify(body.system_columns) === JSON.stringify(requiredSystemColumns), "storage layout declares the complete system-column contract");

  const tablesByRecordType = new Map();
  const physicalTables = new Set();
  for (const mapping of body.tables ?? []) {
    const entry = recordTypes.get(mapping.record_type);
    check(Boolean(entry), `storage table ${mapping.record_type} resolves`);
    check(!tablesByRecordType.has(mapping.record_type), `${mapping.record_type} has only one physical-table mapping`);
    check(/^record_data\.rt_srt_[a-z0-9_]+$/.test(mapping.table) && mapping.table.length <= 63, `${mapping.record_type} physical table token is valid`);
    check(!physicalTables.has(mapping.table), `${mapping.record_type} physical table is collision-free`);
    tablesByRecordType.set(mapping.record_type, mapping);
    physicalTables.add(mapping.table);
    if (entry) {
      check(mapping.storage_contract_id === entry.recordType.storage_contract_id, `${mapping.record_type} storage identity matches its definition`);
      check(mapping.storage_scope === entry.recordType.storage_scope, `${mapping.record_type} storage scope matches its definition`);
      const physicalColumns = new Set();
      for (const field of entry.recordType.fields) {
        const column = `f_${field.id}`;
        check(/^[a-z][a-z0-9_]*$/.test(column) && column.length <= 63, `${mapping.record_type}.${field.key} physical column token is valid`);
        check(!physicalColumns.has(column), `${mapping.record_type}.${field.key} physical column is collision-free`);
        physicalColumns.add(column);
      }
    }
  }
  for (const full of recordTypes.keys()) check(tablesByRecordType.has(full), `${full} resolves to exactly one physical table`);
  check(tablesByRecordType.size === recordTypes.size, "storage layout contains every and only fixture record type");

  const applicationRoots = new Map();
  for (const root of body.application_roots ?? []) {
    check(applications.has(root.application_definition), `application root ${root.application_root_id} definition resolves`);
    check(!applicationRoots.has(root.application_root_id), `application root ${root.application_root_id} is unique`);
    applicationRoots.set(root.application_root_id, root);
  }
  const crmRoots = [...applicationRoots.values()].filter((root) => root.application_definition === "vortex.app.crm");
  check(crmRoots.length === 2 && crmRoots[0].display_name === crmRoots[1].display_name && crmRoots[0].organisation_id !== crmRoots[1].organisation_id, "two same-named CRM roots exist in different organisations");

  const rows = body.row_examples ?? [];
  for (const row of rows) {
    const entry = recordTypes.get(row.record_type);
    const mapping = tablesByRecordType.get(row.record_type);
    check(Boolean(entry) && Boolean(mapping), `storage row ${row.record_id} record type resolves`);
    if (!entry || !mapping) continue;
    check(row.physical_table === mapping.table, `storage row ${row.record_id} uses its lineage table`);
    if (entry.recordType.storage_scope === "organisation_shared") {
      check(row.application_root_id === null, `organisation-shared row ${row.record_id} has no application root`);
    } else {
      check(typeof row.application_root_id === "string" && applicationRoots.has(row.application_root_id), `application-contained row ${row.record_id} has a valid application root`);
      if (applicationRoots.has(row.application_root_id)) check(applicationRoots.get(row.application_root_id).organisation_id === row.organisation_id, `application-contained row ${row.record_id} application belongs to its organisation`);
    }
  }

  const companyRows = rows.filter((row) => row.record_type === "vortex.crm.organisations:company");
  check(companyRows.length === 2 && new Set(companyRows.map((row) => row.organisation_id)).size === 2 && new Set(companyRows.map((row) => row.physical_table)).size === 1, "same package in two organisations reuses one Company table with separate organisation rows");
  const companyMapping = tablesByRecordType.get("vortex.crm.organisations:company");
  const contactMapping = tablesByRecordType.get("vortex.crm.people:contact");
  check(companyMapping?.storage_scope === "organisation_shared" && contactMapping?.storage_scope === "organisation_shared", "CRM and Service Desk shared Company and Contact mappings are organisation-scoped");
  const applicationContainedRows = rows.filter((row) => recordTypes.get(row.record_type)?.recordType.storage_scope === "application_contained");
  check(applicationContainedRows.every((row) => row.application_root_id), "every application-contained example is scoped to an application root");

  const fork = body.fork_example;
  check(fork.source_storage_contract_id !== fork.forked_storage_contract_id, "structural fork has a new storage identity");
  check(fork.source_table !== fork.forked_table, "structural fork has a different physical table");
  check(fork.source_table === companyMapping?.table, "structural fork example starts from the Company lineage");
  check((body.assertions ?? []).length === 9, "storage fixture declares all nine scope and collision assertions");
}

const prohibited = new RegExp("sales" + "[ _-]" + "hub", "i");
for (const path of ["fixture-set.json", ...manifest.files]) {
  const content = await readFile(join(root, path), "utf8");
  check(!prohibited.test(path) && !prohibited.test(content), `${path} uses current application naming`);
}

if (failures.length) {
  console.error(`Fixture validation failed with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Fixture validation passed: ${checks.length} assertions, ${modules.size} modules, ${applications.size} applications, ${connections.size} connection types, ${recordTypes.size} record types, ${fields.size} fields, ${workflowTypes.size} workflow node types, one complete storage layout, and 0 unresolved references.`);
