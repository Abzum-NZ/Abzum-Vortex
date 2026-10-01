import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// The pinned workspace installs tsx as a transitive tool. Locate its loader for this offline
// comparison without adding a production package dependency.
if (!process.argv.includes("--worker")) {
  const virtualStore = path.join(root, "node_modules", ".pnpm");
  const tsxDirectory = readdirSync(virtualStore).find((name) => name.startsWith("tsx@"));
  if (!tsxDirectory)
    throw new Error("The offline definition compiler needs the installed tsx loader");
  const loader = pathToFileURL(
    path.join(virtualStore, tsxDirectory, "node_modules", "tsx", "dist", "loader.mjs"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      loader,
      fileURLToPath(import.meta.url),
      "--worker",
      ...process.argv.slice(2),
    ],
    { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.exitCode = result.status ?? 1;
} else {
  const { compileDefinitionWithContext } = await import("../runtime/definition/src/compiler.ts");
  const { canonicalJson, fingerprintCanonicalValue } =
    await import("../runtime/definition/src/canonical-json.ts");
  const {
    extractApplicationSourceIdentityRequirementsV2,
    extractModuleSourceIdentityRequirementsV3,
    extractSourceIdentityRequirements,
  } = await import("../runtime/definition/src/source-identities.ts");
  const {
    applicationCompilationRequestV2Schema,
    DEFAULT_PLATFORM_THEME_RELEASE_V2,
    IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
    sourceIdentityKindV2Schema,
    sourceIdentityKindSchema,
    sourceProvenanceRegistry,
    jsonValueSchema,
    moduleSourceDocumentSchema,
    applicationSourceDocumentV2Schema,
    connectionTypeSourceDocumentSchema,
    PLATFORM_CONNECTION_TYPE_RELEASES,
  } = await import("../contracts/src/index.ts");
  const { compare: compareVersions } = createRequire(
    path.join(root, "runtime", "definition", "package.json"),
  )("semver");

  if (process.argv.includes("--audit")) {
    const missing = [];
    const seen = new WeakSet();
    const seenLazyGetters = new WeakSet();
    const inspect = (schema, path) => {
      if (seen.has(schema)) return;
      seen.add(schema);
      if (schema === jsonValueSchema || sourceProvenanceRegistry.get(schema)?.includeDescendants)
        return;
      const definition = schema._zod.def;
      switch (definition.type) {
        case "object":
          for (const [key, child] of Object.entries(definition.shape)) {
            if (!sourceProvenanceRegistry.get(child)) missing.push([...path, key].join("/"));
            inspect(child, [...path, key]);
          }
          break;
        case "array":
          inspect(definition.element, [...path, "#"]);
          break;
        case "record":
          inspect(definition.valueType, [...path, "*"]);
          break;
        case "tuple":
          definition.items.forEach((child, index) => inspect(child, [...path, String(index)]));
          break;
        case "union":
          definition.options.forEach((child, index) => inspect(child, [...path, `option${index}`]));
          break;
        case "pipe":
          inspect(definition.out, path);
          break;
        case "lazy":
          if (!seenLazyGetters.has(definition.getter)) {
            seenLazyGetters.add(definition.getter);
            inspect(definition.getter(), path);
          }
          break;
        case "optional":
        case "nullable":
        case "default":
        case "readonly":
          inspect(definition.innerType, path);
          break;
      }
    };
    inspect(moduleSourceDocumentSchema, ["module"]);
    inspect(applicationSourceDocumentV2Schema, ["application"]);
    inspect(connectionTypeSourceDocumentSchema, ["connection"]);
    process.stdout.write(
      `${JSON.stringify({ missingCount: missing.length, missing: missing.slice(0, 100) }, null, 2)}\n`,
    );
    process.exit(0);
  }

  const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const uuidFor = (key) => {
    const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const draftMetadata = {
    organizationId: "10000000-0000-4000-a000-000000000001",
    draftRevision: 1,
    createdAt: "2026-09-01T00:00:00+00:00",
    createdBy: "10000000-0000-4000-a000-000000000002",
    updatedAt: "2026-09-01T00:00:00+00:00",
    updatedBy: "10000000-0000-4000-a000-000000000002",
  };
  const sources = [];
  const failures = [];
  const modulesRoot = path.join(root, "modules", "src");
  for (const directory of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const kind of ["module", "application"]) {
      const relativePath = `modules/src/${directory.name}/${kind}.ts`;
      if (!existsSync(path.join(root, relativePath))) continue;
      try {
        const exports = await import(`../${relativePath}`);
        const values = Object.values(exports).flatMap((value) =>
          Array.isArray(value) ? value : [value],
        );
        for (const source of values) {
          if (source?.kind !== kind) continue;
          sources.push({ path: relativePath, source });
        }
      } catch (error) {
        failures.push({ path: relativePath, stage: "source import", error: String(error) });
      }
    }
  }
  const connectionPath = "contracts/src/catalogue/platform-connection-type-catalogue.source.json";
  const currentConnections = new Map();
  for (const release of PLATFORM_CONNECTION_TYPE_RELEASES) {
    const current = currentConnections.get(release.source.key);
    if (!current || compareVersions(release.releaseVersion, current.releaseVersion) > 0)
      currentConnections.set(release.source.key, release);
  }
  for (const release of currentConnections.values()) {
    const source = connectionTypeSourceDocumentSchema.parse(release.source);
    sources.push({
      path: connectionPath,
      source,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
    });
  }
  const kindOrder = { module: 0, connection_type: 1, application: 2 };
  sources.sort(
    (left, right) =>
      kindOrder[left.source.kind] - kindOrder[right.source.kind] ||
      left.source.key.localeCompare(right.source.key),
  );
  const definitions = sources.map(({ source, rootId, releaseVersion }) => ({
    kind: source.kind,
    key: source.key,
    rootId: rootId ?? uuidFor(`root:${source.kind}:${source.key}`),
    exactVersion: releaseVersion ?? "1.0.0",
    ...(source.kind === "connection_type"
      ? { operationKeys: source.body.operations.map(({ key }) => key) }
      : {}),
  }));
  const requirements = sources.flatMap(({ source }) =>
    source.kind === "module"
      ? extractModuleSourceIdentityRequirementsV3(source)
      : source.kind === "application"
        ? extractApplicationSourceIdentityRequirementsV2(source)
        : extractSourceIdentityRequirements(source),
  );
  const identities = requirements.flatMap((requirement) => {
    const identifier =
      requirement.kind === "root"
        ? definitions.find(({ key }) => key === requirement.definitionKey).rootId
        : uuidFor(
            `${requirement.definitionKey}:${requirement.ownerScope}:${requirement.kind}:${requirement.componentOwner}`,
          );
    return requirement.aliases.map((alias) => ({
      definitionKey: requirement.definitionKey,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier,
    }));
  });
  const snapshot = (contractVersion) => {
    const allowedIdentities =
      contractVersion === "1.0.0"
        ? identities.filter(({ kind }) => sourceIdentityKindSchema.safeParse(kind).success)
        : contractVersion === "2.0.0"
          ? identities.filter(({ kind }) => sourceIdentityKindV2Schema.safeParse(kind).success)
          : identities;
    const evidence = { contractVersion, definitions, identities: allowedIdentities };
    return { ...evidence, fingerprint: fingerprintCanonicalValue(evidence) };
  };
  const catalogueSnapshotFor = (source) => {
    const selected = new Set(
      source.body.platform_block_dependencies.map(
        (dependency) => `${dependency.block_id}@${dependency.release_version}`,
      ),
    );
    const catalogueEvidence = {
      contractVersion: "2.0.0",
      platformBlocks: {
        ...IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
        releases: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases
          .filter((release) => selected.has(`${release.blockId}@${release.releaseVersion}`))
          .sort((left, right) =>
            `${left.blockId}@${left.releaseVersion}`.localeCompare(
              `${right.blockId}@${right.releaseVersion}`,
            ),
          ),
      },
      platformTheme: DEFAULT_PLATFORM_THEME_RELEASE_V2,
    };
    return {
      ...catalogueEvidence,
      fingerprint: fingerprintCanonicalValue(catalogueEvidence),
    };
  };
  const unknownValueShape = () => ({ kind: "unknown" });
  const tokenKey = (token) => token.kind + ":" + token.value;
  const mapValueShape = (tokens) => {
    const unique = new Map();
    for (const token of tokens) unique.set(tokenKey(token), token);
    return { kind: "map", keys: [...unique.values()], complete: true };
  };
  const jsonObjectShape = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? mapValueShape(Object.keys(value).map((key) => ({ kind: "key", value: key })))
      : unknownValueShape();
  const flowValueShape = (value, inputs, state) => {
    if (value === null || typeof value !== "object") return unknownValueShape();
    if (value.kind === "map" && value.entries && typeof value.entries === "object")
      return mapValueShape(Object.keys(value.entries).map((key) => ({ kind: "key", value: key })));
    if (value.kind === "literal" && value.literal?.type === "json")
      return jsonObjectShape(value.literal.value);
    if (value.kind === "reference" && value.reference && typeof value.reference === "object") {
      const reference = value.reference;
      if (reference.source === "input") return inputs.get(reference.name) ?? unknownValueShape();
      if (reference.source === "variable")
        return state.variables.get(reference.name) ?? unknownValueShape();
      if (reference.source === "task_output" && reference.path === undefined)
        return state.taskValues.get(reference.task + ":" + reference.key) ?? unknownValueShape();
    }
    return unknownValueShape();
  };
  const joinValueShapes = (shapes) => {
    if (
      shapes.length === 0 ||
      shapes.some((shape) => shape.kind !== "map" || shape.complete !== true)
    )
      return unknownValueShape();
    const common = new Map(shapes[0].keys.map((token) => [tokenKey(token), token]));
    for (const shape of shapes.slice(1)) {
      const present = new Set(shape.keys.map(tokenKey));
      for (const key of common.keys()) if (!present.has(key)) common.delete(key);
    }
    return { kind: "map", keys: [...common.values()], complete: true };
  };
  const cloneFlowState = (state) => ({
    variables: new Map(state.variables),
    taskValues: new Map(state.taskValues),
    reachable: state.reachable,
  });
  const joinFlowStates = (states) => {
    const reachable = states.filter((state) => state.reachable);
    if (reachable.length === 0)
      return { variables: new Map(), taskValues: new Map(), reachable: false };
    const joinMaps = (property) => {
      const keys = new Set(reachable.flatMap((state) => [...state[property].keys()]));
      return new Map(
        [...keys].map((key) => [
          key,
          joinValueShapes(
            reachable.map((state) => state[property].get(key) ?? unknownValueShape()),
          ),
        ]),
      );
    };
    return {
      variables: joinMaps("variables"),
      taskValues: joinMaps("taskValues"),
      reachable: true,
    };
  };
  const aliasesForIdentity = (definitionKey, kind, identifier) =>
    identities
      .filter(
        (identity) =>
          identity.definitionKey === definitionKey &&
          identity.kind === kind &&
          identity.identifier === identifier,
      )
      .map((identity) => identity.alias)
      .sort((left, right) => left.localeCompare(right));
  const applicationCatalogueReleases = new Map();
  const ambiguousApplicationCatalogueReleases = new Set();
  for (const release of IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases) {
    const identity = release.blockId + "@" + release.releaseVersion;
    if (applicationCatalogueReleases.has(identity))
      ambiguousApplicationCatalogueReleases.add(identity);
    else applicationCatalogueReleases.set(identity, release);
  }
  const validateRequiredCreateFieldCoverage = (source, output, priorOutputs) => {
    const content = output?.canonical?.content;
    if (source.kind !== "application" || content === undefined) return [];
    const appKey = source.key;
    const selectedBlockReleases = new Set(
      (content.platformBlockDependencies ?? []).map(
        (dependency) => dependency.blockId + "@" + dependency.releaseVersion,
      ),
    );
    const releaseForPlacement = (placement) => {
      const block = placement?.block;
      if (
        block === null ||
        typeof block !== "object" ||
        typeof block.blockId !== "string" ||
        typeof block.releaseVersion !== "string"
      )
        return undefined;
      const identity = block.blockId + "@" + block.releaseVersion;
      if (
        !selectedBlockReleases.has(identity) ||
        ambiguousApplicationCatalogueReleases.has(identity)
      )
        return undefined;
      return applicationCatalogueReleases.get(identity);
    };
    const formInstances = [];
    const formInstanceByPageAndPlacement = new Map();
    const formAlias = (placementId) =>
      aliasesForIdentity(appKey, "block_placement", placementId)[0] ?? placementId;
    const makeFormInstance = (page, placementId) => {
      const identity = page.pageId + ":" + placementId;
      let instance = formInstanceByPageAndPlacement.get(identity);
      if (instance === undefined) {
        instance = {
          pageId: page.pageId,
          pageKey: page.key,
          placementId,
          placementAlias: formAlias(placementId),
          controls: [],
          issues: [],
        };
        formInstanceByPageAndPlacement.set(identity, instance);
        formInstances.push(instance);
      }
      return instance;
    };
    const addFormIssue = (form, issue) => {
      if (!form.issues.includes(issue)) form.issues.push(issue);
    };
    const settingText = (settings, key) => {
      const value = settings[key];
      return value?.kind === "text" && typeof value.value === "string"
        ? value.value
        : undefined;
    };
    const addFieldControl = (form, placement, release) => {
      const settings =
        placement.settings !== null && typeof placement.settings === "object"
          ? placement.settings
          : {};
      const disabled = settings.disabled;
      if (disabled?.kind === "boolean" && disabled.value === true) return;
      const properties = Array.isArray(release.properties) ? release.properties : [];
      const derived = properties.filter((property) => property.derivesFieldInput === true);
      let control;
      if (derived.length > 0) {
        if (derived.length !== 1) {
          addFormIssue(form, "an automatic field input has ambiguous registered field metadata");
          return;
        }
        const value = settings[derived[0].key];
        if (value?.kind !== "field_reference" || typeof value.fieldId !== "string") {
          addFormIssue(form, "an automatic field input has no exact compiled field identity");
          return;
        }
        const name = settingText(settings, "name");
        if (name === undefined) {
          addFormIssue(form, "an automatic field input has no exact compiled input name");
          return;
        }
        control = { name, token: { kind: "id", value: value.fieldId } };
      } else {
        const nameProperties = properties.filter(
          (property) => property.key === "name" && property.kind === "text",
        );
        const name = settingText(settings, "name");
        if (nameProperties.length !== 1 || name === undefined || name.length === 0) {
          addFormIssue(form, "a registered input has no unique named-field declaration");
          return;
        }
        control = { name, token: { kind: "key", value: name } };
      }
      const sameName = form.controls.filter((candidate) => candidate.name === control.name);
      if (sameName.some((candidate) => tokenKey(candidate.token) !== tokenKey(control.token))) {
        addFormIssue(form, "the owning form has ambiguous registered input names");
        return;
      }
      if (
        !form.controls.some(
          (candidate) =>
            candidate.name === control.name &&
            tokenKey(candidate.token) === tokenKey(control.token),
        )
      )
        form.controls.push(control);
    };
    const walkSlot = (slot, page, activeForm, substitutions) => {
      if (slot === null || typeof slot !== "object") {
        if (activeForm !== undefined)
          addFormIssue(activeForm, "the owning form has an unresolved ordered slot");
        return;
      }
      const placements = slot.placements;
      const order = slot.order;
      if (
        placements === null ||
        typeof placements !== "object" ||
        order === null ||
        typeof order !== "object" ||
        !Array.isArray(order.desktop) ||
        !Array.isArray(order.tablet) ||
        !Array.isArray(order.phone)
      ) {
        if (activeForm !== undefined)
          addFormIssue(activeForm, "the owning form has an unresolved ordered slot");
        return;
      }
      const orderedPlacementIds = [
        ...new Set([...order.desktop, ...order.tablet, ...order.phone]),
      ];
      for (const placementId of orderedPlacementIds) {
        const placement = placements[placementId];
        if (placement === undefined) {
          if (activeForm !== undefined)
            addFormIssue(activeForm, "the owning form has an unresolved ordered placement");
          continue;
        }
        const release = releaseForPlacement(placement);
        if (activeForm !== undefined && release === undefined)
          addFormIssue(activeForm, "a placement has no unique selected immutable block release");
        let owningForm = activeForm;
        if (release?.supportedEvents?.includes("form_submit") === true)
          owningForm = makeFormInstance(page, placementId);
        else if (
          owningForm !== undefined &&
          release?.paletteGroup === "input" &&
          release?.supportedEvents?.includes("field_changed") === true
        )
          addFieldControl(owningForm, placement, release);
        const childSlots =
          placement.slots !== null && typeof placement.slots === "object"
            ? placement.slots
            : {};
        for (const [slotKey, childSlot] of Object.entries(childSlots)) {
          const replacement = substitutions.get(placementId + ":" + slotKey);
          walkSlot(replacement ?? childSlot, page, owningForm, substitutions);
        }
      }
    };
    const shellsById = new Map((content.shells ?? []).map((shell) => [shell.shellId, shell]));
    for (const page of content.pages ?? []) {
      const composition = page.composition;
      if (composition === null || typeof composition !== "object") continue;
      const guided = page.type === "guided_form";
      if (composition.shellKind === "application") {
        const shell = shellsById.get(composition.shellId);
        if (shell === undefined) continue;
        const pageSlotSets = guided
          ? Object.values(composition.stepContent ?? {})
          : composition.content === undefined
            ? []
            : [composition.content];
        for (const pageSlots of pageSlotSets) {
          const substitutions = new Map();
          for (const slot of shell.contentSlots ?? []) {
            const pageSlot = pageSlots[slot.slotId];
            if (pageSlot !== undefined)
              substitutions.set(slot.parentPlacementId + ":" + slot.parentSlotKey, pageSlot);
          }
          walkSlot(shell.layout, page, undefined, substitutions);
        }
      } else if (guided) {
        for (const slot of Object.values(composition.stepContent ?? {}))
          walkSlot(slot, page, undefined, new Map());
      } else if (composition.main !== undefined)
        walkSlot(composition.main, page, undefined, new Map());
    }
    const formsByPlacement = new Map();
    for (const form of formInstances) {
      const instances = formsByPlacement.get(form.placementId) ?? [];
      instances.push(form);
      formsByPlacement.set(form.placementId, instances);
    }
    const flowById = new Map((content.flows ?? []).map((flow) => [flow.id, flow]));
    const eventById = new Map((content.events ?? []).map((event) => [event.eventId, event]));
    const moduleOutputsByExactDependency = new Map();
    for (const candidate of priorOutputs) {
      if (
        candidate.kind !== "module" ||
        candidate.artifact?.rootId !== candidate.canonical?.envelope?.rootId ||
        candidate.artifact?.definitionKey !== candidate.canonical?.envelope?.key ||
        candidate.artifact?.exactVersion === undefined
      )
        continue;
      const identity =
        candidate.artifact.rootId + "@" + candidate.artifact.exactVersion;
      const matches = moduleOutputsByExactDependency.get(identity) ?? [];
      matches.push(candidate);
      moduleOutputsByExactDependency.set(identity, matches);
    }
    const moduleOutputs = [];
    const pendingModuleDependencies = [...(content.moduleBindings ?? [])];
    const visitedModuleDependencies = new Set();
    while (pendingModuleDependencies.length > 0) {
      const dependency = pendingModuleDependencies.pop();
      if (
        dependency === undefined ||
        typeof dependency.moduleRootId !== "string" ||
        typeof dependency.resolvedVersion !== "string"
      )
        continue;
      const identity = dependency.moduleRootId + "@" + dependency.resolvedVersion;
      if (visitedModuleDependencies.has(identity)) continue;
      visitedModuleDependencies.add(identity);
      const matches = moduleOutputsByExactDependency.get(identity) ?? [];
      if (matches.length !== 1) continue;
      const moduleOutput = matches[0];
      moduleOutputs.push(moduleOutput);
      pendingModuleDependencies.push(...(moduleOutput.canonical.content.dependencies ?? []));
    }
    const resolveTargetRecord = (recordTypeId) => {
      const matches = [];
      for (const moduleOutput of moduleOutputs)
        for (const record of moduleOutput.canonical?.content?.recordTypes ?? [])
          if (record.recordTypeId === recordTypeId) matches.push(record);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const diagnostic = (form, flow, task, target, reason, missingFields) => {
      const flowLabel =
        aliasesForIdentity(appKey, "flow", flow?.id)[0] ??
        flow?.key ??
        flow?.id ??
        "unresolved flow";
      const formLabel =
        form === undefined
          ? "unresolved form placement"
          : form.pageKey + "/" + form.placementAlias;
      const targetLabel = target?.key ?? target ?? "unresolved target";
      const missing =
        missingFields.length === 0
          ? ""
          : " Missing required fields: " +
            missingFields
              .map((field) => field.key + " (" + field.fieldId + ")")
              .sort((left, right) => left.localeCompare(right))
              .join(", ") +
            ".";
      return (
        "Required create-field coverage rejected Application " +
        JSON.stringify(appKey) +
        ", form " +
        JSON.stringify(formLabel) +
        ", flow " +
        JSON.stringify(flowLabel) +
        ", save " +
        JSON.stringify(task?.id ?? "unresolved save") +
        ", target " +
        JSON.stringify(targetLabel) +
        ": " +
        reason +
        "." +
        missing
      );
    };
    const targetFieldsForMap = (shape, record) => {
      if (shape.kind !== "map" || shape.complete !== true) return undefined;
      const fields = Array.isArray(record.fields) ? record.fields : [];
      const byId = new Map();
      const byKey = new Map();
      for (const field of fields) {
        if (typeof field.fieldId !== "string" || typeof field.key !== "string") return undefined;
        if (byId.has(field.fieldId) || byKey.has(field.key)) return undefined;
        byId.set(field.fieldId, field);
        byKey.set(field.key, field);
      }
      const ids = new Set();
      for (const token of shape.keys) {
        const candidates =
          token.kind === "id"
            ? [byId.get(token.value)].filter(Boolean)
            : [byKey.get(token.value), byId.get(token.value)].filter(Boolean);
        if (new Set(candidates.map((field) => field.fieldId)).size > 1) return undefined;
        for (const field of candidates) ids.add(field.fieldId);
      }
      return { ids, fields };
    };
    const findings = [];
    const flowContainsRecordSave = (candidate, seen = new Set()) => {
      if (candidate === undefined || seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      const visit = (tasks) =>
        (tasks ?? []).some((task) => {
          if (
            task.type === "record.save" &&
            !Object.hasOwn(task.properties ?? {}, "record")
          )
            return true;
          if (task.type === "run_flow")
            return flowContainsRecordSave(flowById.get(task.flowId), seen);
          if (task.type === "if")
            return visit(task.then) || (task.else !== undefined && visit(task.else));
          if (task.type === "switch")
            return (
              (task.cases ?? []).some((entry) => visit(entry.tasks)) ||
              (task.default !== undefined && visit(task.default))
            );
          if (task.type === "parallel")
            return (task.branches ?? []).some((branch) => visit(branch));
          return Array.isArray(task.tasks) && visit(task.tasks);
        });
      return (
        visit(candidate.tasks) ||
        visit(candidate.errors) ||
        visit(candidate.finally)
      );
    };
    const findFirstRecordSave = (candidate, seen = new Set()) => {
      if (candidate === undefined || seen.has(candidate.id)) return undefined;
      seen.add(candidate.id);
      const find = (flow) => {
        for (const task of flow.tasks ?? []) {
          if (
            task.type === "record.save" &&
            !Object.hasOwn(task.properties ?? {}, "record")
          )
            return { flow, task };
          const children =
            task.type === "if"
              ? [task.then, task.else ?? []]
              : task.type === "switch"
                ? [...(task.cases ?? []).map((entry) => entry.tasks), task.default ?? []]
                : task.type === "parallel"
                  ? task.branches ?? []
                  : Array.isArray(task.tasks)
                    ? [task.tasks]
                    : [];
          for (const list of children) {
            const result = find({ tasks: list });
            if (result !== undefined) return result;
          }
          if (task.type === "run_flow") {
            const result = findFirstRecordSave(flowById.get(task.flowId), seen);
            if (result !== undefined) return result;
          }
        }
        return undefined;
      };
      return (
        find(candidate) ??
        find({ tasks: candidate.errors ?? [] }) ??
        find({ tasks: candidate.finally ?? [] })
      );
    };
    const analyzeFlow = (flow, inputShapes, form, bindingIssue, eventRecordTypeId, callStack) => {
      const variables = new Map();
      for (const [name, declaration] of Object.entries(flow.variables ?? {}))
        variables.set(
          name,
          Object.hasOwn(declaration, "default")
            ? jsonObjectShape(declaration.default)
            : unknownValueShape(),
        );
      const state = { variables, taskValues: new Map(), reachable: true };
      const walkTasks = (tasks, workingState, currentInputs, stack) => {
        for (const task of tasks ?? []) {
          if (!workingState.reachable) break;
          if (task.type === "sequential") {
            walkTasks(task.tasks, workingState, currentInputs, stack);
            continue;
          }
          if (task.type === "if") {
            const thenState = cloneFlowState(workingState);
            walkTasks(task.then, thenState, currentInputs, stack);
            const branches = [thenState];
            if (task.else === undefined) branches.push(cloneFlowState(workingState));
            else {
              const elseState = cloneFlowState(workingState);
              walkTasks(task.else, elseState, currentInputs, stack);
              branches.push(elseState);
            }
            Object.assign(workingState, joinFlowStates(branches));
            continue;
          }
          if (task.type === "switch") {
            const branches = [];
            for (const entry of task.cases ?? []) {
              const branch = cloneFlowState(workingState);
              walkTasks(entry.tasks, branch, currentInputs, stack);
              branches.push(branch);
            }
            if (task.default === undefined) branches.push(cloneFlowState(workingState));
            else {
              const fallback = cloneFlowState(workingState);
              walkTasks(task.default, fallback, currentInputs, stack);
              branches.push(fallback);
            }
            Object.assign(workingState, joinFlowStates(branches));
            continue;
          }
          if (task.type === "for_each") {
            const body = cloneFlowState(workingState);
            walkTasks(task.tasks, body, currentInputs, stack);
            Object.assign(workingState, joinFlowStates([cloneFlowState(workingState), body]));
            continue;
          }
          if (task.type === "parallel") {
            const branches = [];
            for (const branchTasks of task.branches ?? []) {
              const branch = cloneFlowState(workingState);
              walkTasks(branchTasks, branch, currentInputs, stack);
              branches.push(branch);
            }
            if (branches.length > 0) Object.assign(workingState, joinFlowStates(branches));
            continue;
          }
          if (task.type === "stop") {
            workingState.reachable = false;
            break;
          }
          if (task.type === "run_flow") {
            const child = flowById.get(task.flowId);
            if (child === undefined) continue;
            if (stack.has(child.id)) {
              if (flowContainsRecordSave(child)) {
                const first = findFirstRecordSave(child);
                findings.push(
                  diagnostic(
                    form,
                    first?.flow ?? child,
                    first?.task,
                    undefined,
                    "a recursive flow call prevents bounded producer analysis",
                    [],
                  ),
                );
              }
              continue;
            }
            const childInputs = new Map();
            for (const [name, declaration] of Object.entries(child.inputs ?? {})) {
              const value = task.inputs?.[name];
              childInputs.set(
                name,
                value === undefined
                  ? Object.hasOwn(declaration, "default")
                    ? jsonObjectShape(declaration.default)
                    : unknownValueShape()
                  : flowValueShape(value, currentInputs, workingState),
              );
            }
            const childStack = new Set(stack);
            childStack.add(child.id);
            const childResult = analyzeFlow(
              child,
              childInputs,
              form,
              bindingIssue,
              eventRecordTypeId,
              childStack,
            );
            for (const [name, shape] of childResult.outputs)
              workingState.taskValues.set(task.id + ":" + name, shape);
            continue;
          }
          if (task.type === "record.save") {
            const properties =
              task.properties !== null && typeof task.properties === "object"
                ? task.properties
                : {};
            if (Object.hasOwn(properties, "record")) continue;
            const targetValue = properties.record_type;
            const targetId =
              targetValue?.kind === "literal" &&
              targetValue.literal?.type === "text" &&
              typeof targetValue.literal.value === "string"
                ? targetValue.literal.value
                : undefined;
            const targetRecord = targetId === undefined ? undefined : resolveTargetRecord(targetId);
            if (form === undefined)
              findings.push(
                diagnostic(
                  form,
                  flow,
                  task,
                  targetRecord ?? targetId,
                  bindingIssue ??
                    "the form-submit binding does not resolve to one registered form placement",
                  [],
                ),
              );
            else if (bindingIssue !== undefined || form.issues.length > 0)
              findings.push(
                diagnostic(
                  form,
                  flow,
                  task,
                  targetRecord ?? targetId,
                  bindingIssue ?? form.issues.join("; "),
                  [],
                ),
              );
            else if (targetId === undefined || targetRecord === undefined)
              findings.push(
                diagnostic(
                  form,
                  flow,
                  task,
                  targetId,
                  "the save target does not resolve to exactly one record type in a bound Module",
                  [],
                ),
              );
            else if (eventRecordTypeId !== undefined && eventRecordTypeId !== targetId)
              findings.push(
                diagnostic(
                  form,
                  flow,
                  task,
                  targetRecord,
                  "the bound form event record type differs from the create target",
                  [],
                ),
              );
            else {
              const submittedShape = flowValueShape(
                properties.values,
                currentInputs,
                workingState,
              );
              if (submittedShape.kind !== "map" || submittedShape.complete !== true)
                findings.push(
                  diagnostic(
                    form,
                    flow,
                    task,
                    targetRecord,
                    "the submitted values producer is not a statically bounded field map",
                    [],
                  ),
                );
              else {
                const fieldMap = targetFieldsForMap(submittedShape, targetRecord);
                if (fieldMap === undefined)
                  findings.push(
                    diagnostic(
                      form,
                      flow,
                      task,
                      targetRecord,
                      "the submitted field map has ambiguous target-field identities",
                      [],
                    ),
                  );
                else {
                  const generated = new Set(["reference_number", "calculation", "total"]);
                  const missingFields = fieldMap.fields.filter(
                    (field) =>
                      field.required === true &&
                      !generated.has(field.type) &&
                      !(
                        Object.hasOwn(field, "default") &&
                        field.default !== undefined &&
                        field.default !== null
                      ) &&
                      !fieldMap.ids.has(field.fieldId),
                  );
                  if (missingFields.length > 0)
                    findings.push(
                      diagnostic(
                        form,
                        flow,
                        task,
                        targetRecord,
                        "the create save omits required fields from its current bound form or closed flow producer",
                        missingFields,
                      ),
                    );
                }
              }
            }
            continue;
          }
          if (task.type === "data.set_variable") {
            const properties =
              task.properties !== null && typeof task.properties === "object"
                ? task.properties
                : {};
            const variableValue = properties.variable;
            const variableName =
              variableValue?.kind === "literal" &&
              variableValue.literal?.type === "text" &&
              typeof variableValue.literal.value === "string"
                ? variableValue.literal.value
                : undefined;
            const assignedShape = flowValueShape(properties.value, currentInputs, workingState);
            if (variableName === undefined) {
              for (const name of workingState.variables.keys())
                workingState.variables.set(name, unknownValueShape());
            } else workingState.variables.set(variableName, assignedShape);
          }
        }
      };
      walkTasks(flow.tasks, state, inputShapes, callStack);
      const errorEntryState = cloneFlowState(state);
      errorEntryState.reachable = true;
      for (const name of errorEntryState.variables.keys())
        errorEntryState.variables.set(name, unknownValueShape());
      for (const key of errorEntryState.taskValues.keys())
        errorEntryState.taskValues.set(key, unknownValueShape());
      const errorState = cloneFlowState(errorEntryState);
      walkTasks(flow.errors, errorState, inputShapes, callStack);
      const finallyState = joinFlowStates([state, errorEntryState, errorState]);
      finallyState.reachable = true;
      walkTasks(flow.finally, finallyState, inputShapes, callStack);
      const outputs = new Map();
      for (const [name, declaration] of Object.entries(flow.outputs ?? {})) {
        let shape = flowValueShape(declaration.value, inputShapes, state);
        const value = declaration.value;
        const reference = value?.kind === "reference" ? value.reference : undefined;
        if (
          (flow.finally ?? []).length > 0 &&
          reference !== undefined &&
          (reference.source === "variable" || reference.source === "task_output")
        )
          shape = unknownValueShape();
        outputs.set(name, shape);
      }
      return { state, inputs: inputShapes, outputs };
    };
    const bindingInputShapes = (flow, binding, form) => {
      const shapes = new Map();
      const supplied = binding?.flow?.inputs ?? {};
      for (const [name, declaration] of Object.entries(flow.inputs ?? {})) {
        const value = supplied[name];
        if (value?.kind === "caller") {
          if (declaration.type === "json" && value.name === "values" && form !== undefined)
            shapes.set(name, mapValueShape(form.controls.map((control) => control.token)));
          else shapes.set(name, unknownValueShape());
        } else if (value?.kind === "literal" && declaration.type === "json")
          shapes.set(name, jsonObjectShape(value.literal?.value));
        else if (Object.hasOwn(declaration, "default"))
          shapes.set(name, jsonObjectShape(declaration.default));
        else shapes.set(name, unknownValueShape());
      }
      return shapes;
    };
    for (const binding of content.flowBindings ?? []) {
      if (binding.event !== "form_submit") continue;
      const flow = flowById.get(binding.flow?.flowId);
      const matchingForms = formsByPlacement.get(binding.controlId) ?? [];
      const event = eventById.get(binding.eventId);
      const bindingIssue =
        event === undefined || typeof event.recordTypeId !== "string"
          ? "the bound form event does not resolve to one declared Application event"
          : undefined;
      if (flow === undefined) {
        findings.push(
          diagnostic(
            matchingForms[0],
            undefined,
            undefined,
            undefined,
            "the form-submit binding has no exact resolved Application flow",
            [],
          ),
        );
        continue;
      }
      const contexts = matchingForms.length === 0 ? [undefined] : matchingForms;
      for (const form of contexts)
        analyzeFlow(
          flow,
          bindingInputShapes(flow, binding, form),
          form,
          bindingIssue,
          event?.recordTypeId,
          new Set([flow.id]),
        );
    }
    return [...new Set(findings)];
  };
  const outputs = [];
  const results = [];
  let requiredCreateFieldCoverageRejected = false;
  const outputDirectoryIndex = process.argv.indexOf("--output-dir");
  const outputDirectory =
    outputDirectoryIndex < 0 ? undefined : process.argv[outputDirectoryIndex + 1];
  if (outputDirectoryIndex >= 0 && !outputDirectory)
    throw new Error("--output-dir requires a directory path");
  if (outputDirectory) mkdirSync(outputDirectory, { recursive: true });
  for (const { path: sourcePath, source } of sources) {
    try {
      const request =
        source.kind === "connection_type"
          ? { source, resolution: snapshot("1.0.0") }
          : source.kind === "module"
            ? {
                sourceContractVersion: "3.0.0",
                validationContractVersion: "3.0.0",
                source,
                resolution: snapshot("3.0.0"),
                draftMetadata,
                savedConditionRevisions: identities
                  .filter(
                    ({ definitionKey, kind }) =>
                      definitionKey === source.key && kind === "sharing_condition",
                  )
                  .map(({ identifier }) => identifier)
                  .filter((identifier, index, all) => all.indexOf(identifier) === index)
                  .map((identifier) => ({ conditionId: identifier, revision: 1 })),
              }
            : {
                sourceContractVersion: "2.0.0",
                validationContractVersion: "2.0.0",
                source,
                resolution: snapshot("2.0.0"),
                catalogueSnapshot: catalogueSnapshotFor(source),
                draftMetadata,
              };
      if (source.kind === "application") {
        const parsed = applicationCompilationRequestV2Schema.safeParse(request);
        if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      }
      const output = compileDefinitionWithContext(request, { dependencyOutputs: outputs });
      if (source.kind === "application") {
        const coverageFindings = validateRequiredCreateFieldCoverage(source, output, outputs);
        if (coverageFindings.length > 0) {
          requiredCreateFieldCoverageRejected = true;
          for (const error of coverageFindings)
            failures.push({
              path: sourcePath,
              kind: source.kind,
              key: source.key,
              stage: "required create-field coverage",
              error,
            });
          continue;
        }
      }
      outputs.push(output);
      const bytes = canonicalJson(output);
      if (outputDirectory)
        writeFileSync(
          path.join(outputDirectory, `${source.kind}--${source.key}.json`),
          bytes,
          "utf8",
        );
      results.push({
        path: sourcePath,
        kind: source.kind,
        key: source.key,
        sha256: sha256(bytes),
      });
    } catch (error) {
      failures.push({
        path: sourcePath,
        kind: source.kind,
        key: source.key,
        stage: "compile",
        error: String(error),
        location: error.location,
      });
    }
  }
  results.sort((left, right) => left.key.localeCompare(right.key));
  failures.sort((left, right) => left.path.localeCompare(right.path));
  if (requiredCreateFieldCoverageRejected) process.exitCode = 1;
  process.stdout.write(
    `${JSON.stringify({ discovered: sources.length, compiled: results.length, results, failures }, null, 2)}\n`,
  );
}
