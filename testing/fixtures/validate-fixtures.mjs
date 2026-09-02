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
const events = new Set();
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
    permissions.add(action.permission);
    check(recordTypes.has(`${moduleKey}:${action.record_type}`), `${action.key} record type resolves`);
  }
  for (const event of module.body.events ?? []) {
    events.add(event.key);
    const entry = recordTypes.get(`${moduleKey}:${event.record_type}`);
    check(Boolean(entry), `${event.key} record type resolves`);
    if (entry) {
      const available = new Set(entry.recordType.fields.map((field) => field.key));
      check((event.carries ?? []).every((field) => available.has(field)), `${event.key} carried fields resolve`);
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
  check(application.body.motion?.library === "motion/react", `${path} uses the approved coordinated-motion library`);
  check(application.body.motion?.simple_feedback === "css", `${path} reserves CSS for simple feedback`);
  check(JSON.stringify(application.body.motion?.semantic_tokens) === JSON.stringify(["feedback", "enter_exit", "refresh", "panel", "page", "layout_spring"]), `${path} uses only the six semantic motion tokens`);
  check(application.body.motion?.current_state_wins === true, `${path} makes motion interruptible by current state`);
  check(application.body.motion?.reduced_motion === "required", `${path} requires reduced-motion behaviour`);
  check(application.body.motion?.experimental_view_transitions === false, `${path} excludes experimental view transitions`);

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
    if (workflow.trigger.event) check(events.has(workflow.trigger.event), `${path} workflow ${workflow.key} event resolves`);
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    for (const node of workflow.nodes) {
      workflowTypes.add(node.type);
      check(manifest.required_workflow_nodes.includes(node.type), `${path} workflow ${workflow.key} node ${node.type} is registered`);
      if (node.config.action) check(actions.has(node.config.action), `${path} workflow ${workflow.key} action ${node.config.action} resolves`);
      if (node.config.query) check(appQueries.has(node.config.query), `${path} workflow ${workflow.key} query ${node.config.query} resolves`);
      if (node.config.page) check(appPages.has(node.config.page), `${path} workflow ${workflow.key} page ${node.config.page} resolves`);
      if (node.config.workflow) check(appWorkflows.has(node.config.workflow), `${path} workflow ${workflow.key} child workflow ${node.config.workflow} resolves`);
      if (node.config.record_type) check(recordTypes.has(node.config.record_type), `${path} workflow ${workflow.key} record type ${node.config.record_type} resolves`);
      if (node.config.connection) {
        const binding = appConnections.get(node.config.connection);
        check(Boolean(binding), `${path} workflow ${workflow.key} connection ${node.config.connection} resolves`);
        if (binding) check(binding.required_operations.includes(node.config.operation), `${path} workflow ${workflow.key} connection operation ${node.config.operation} is bound`);
      }
    }
    for (const [from, to] of workflow.edges) check(nodeIds.has(from) && nodeIds.has(to), `${path} workflow ${workflow.key} edge ${from}->${to} resolves`);
  }

  for (const pipeline of application.body.pipelines ?? []) {
    const entry = recordTypes.get(pipeline.record_type);
    check(Boolean(entry), `${path} pipeline ${pipeline.key} record type resolves`);
    if (entry) check(entry.recordType.fields.some((field) => field.key === pipeline.stage_field && field.type === "choice"), `${path} pipeline ${pipeline.key} stage field resolves to a choice`);
    for (const transition of pipeline.transitions) {
      check(pipeline.stages.includes(transition.from) && pipeline.stages.includes(transition.to), `${path} pipeline ${pipeline.key} transition stages resolve`);
      if (transition.action) check(actions.has(transition.action), `${path} pipeline ${pipeline.key} action ${transition.action} resolves`);
      if (transition.permission) check(permissions.has(transition.permission), `${path} pipeline ${pipeline.key} permission ${transition.permission} resolves`);
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
