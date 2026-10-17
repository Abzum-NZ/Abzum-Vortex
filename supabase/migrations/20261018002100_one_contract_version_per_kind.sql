-- One accepted contract version per definition kind (#2770, epic #2718).
-- accepted_contract_version(kind) returns exactly one version for application, module and
-- record_type; it is the single SQL source of truth. The module-source ownership predicate, the
-- query resolvers and the saved-condition evaluator take their version from it instead of
-- hard-coding literals, and the older-version branches (exact_values in the saved-condition
-- evaluator and the read-scan planner) are removed. Privileges are unchanged.
set local role vortex_owner;

create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['3.0.0'];
    when 'module' then
      return array['3.0.0'];
    when 'record_type' then
      return array['3.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;


-- The Module query resolvers and the read-scan planner run as vortex_record_adapter and read the
-- accepted version from this function, so that role may execute it (it reads no data).
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_record_adapter;

comment on function vortex_definition.accepted_contract_version(text) is
  'The one accepted definition contract version per contract kind (a one-element array); the single SQL source of truth, compared with the TypeScript constants by the guard. application: vortex_definition.provision_module_installation_storage and vortex_definition.activate/detach_application_installation. module: vortex_record.provision_exact_module_storage. record_type: vortex_access.evaluate_organization_record_access_internal.';

create or replace function vortex_definition.is_owned_module_source_internal(
  p_owner_application_root_id uuid,
  p_organization_id uuid,
  p_source jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- A Module source is exactly the lowering of one inline Module of its owning Application's
  -- current draft: the inline Module's alias, key and body, naming that Application as its owner,
  -- under the one accepted Module contract version (accepted_contract_version('module')). Nothing else may
  -- differ; a Module's dependencies are derived when it is compiled and never stored.
  select exists (
    select 1
    from vortex_definition.roots as owner_root
    join vortex_definition.drafts as owner_draft on owner_draft.root_id = owner_root.root_id
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(owner_draft.draft_source #> '{body,modules}', '[]'::jsonb)
    ) as inline_module(value)
    where owner_root.root_id = p_owner_application_root_id
      and owner_root.organization_id = p_organization_id
      and owner_root.kind = 'application'
      and p_source = pg_catalog.jsonb_build_object(
        'source_contract_version', (vortex_definition.accepted_contract_version('module'))[1],
        'root_alias', inline_module.value -> 'id',
        'key', inline_module.value -> 'key',
        'kind', 'module',
        'body', (inline_module.value - 'id' - 'key')
          || pg_catalog.jsonb_build_object('owner_application', owner_root.key)
      )
  );
$function$;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  scope_condition jsonb;
  field_entry jsonb;
  field_id text;
  field_kind text;
  result_kind text;
  semantic_type text;
  field_types jsonb := '{}'::jsonb;
  declared_fields jsonb;
  declaration jsonb;
  binding jsonb;
  parameter_key text;
  parameter_type text;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  declaration_keys text[] := array[]::text[];
  binding_keys text[] := array[]::text[];
  key_count integer;
  tree_depth integer;
  tree_operands integer;
  supplied_key text;
  supplied_value jsonb;
  contract_version text;
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
begin
  if p_record_scope is null or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object'
    or p_saved_condition is null or pg_catalog.jsonb_typeof(p_saved_condition) is distinct from 'object'
    or p_source_record_type is null or pg_catalog.jsonb_typeof(p_source_record_type) is distinct from 'object'
    or p_field_values is null or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or p_current_organization_account_id is null
    or p_current_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  -- The evaluator selects semantics only from explicit trusted version
  -- evidence. Actual adapter facts below always carry the pinned version.
  contract_version := p_source_record_type ->> 'validationContractVersion';
  if not (p_source_record_type ? 'validationContractVersion')
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'validationContractVersion') is distinct from 'string'
    or contract_version <> all (vortex_definition.accepted_contract_version('record_type')) then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  scope_condition := p_record_scope -> 'savedCondition';
  if pg_catalog.jsonb_typeof(scope_condition) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(scope_condition);
  if key_count <> 4
    or pg_catalog.jsonb_typeof(scope_condition -> 'conditionId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(scope_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(scope_condition -> 'publishedRevision') is distinct from 'number'
    or (scope_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (scope_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(scope_condition -> 'contractFingerprint') is distinct from 'string'
    or (scope_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(scope_condition -> 'parameterBindings') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if pg_catalog.jsonb_typeof(p_saved_condition -> 'conditionId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_saved_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'sourceRecordTypeId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_saved_condition ->> 'sourceRecordTypeId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'publishedRevision') is distinct from 'number'
    or (p_saved_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (p_saved_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'contractFingerprint') is distinct from 'string'
    or (p_saved_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'parameters') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'condition') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'declaredFieldIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'recordTypeId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_source_record_type ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'fields') is distinct from 'array'
    or scope_condition ->> 'conditionId' <> p_saved_condition ->> 'conditionId'
    or (scope_condition ->> 'publishedRevision')::numeric <> (p_saved_condition ->> 'publishedRevision')::numeric
    or scope_condition ->> 'contractFingerprint' <> p_saved_condition ->> 'contractFingerprint'
    or p_saved_condition ->> 'sourceRecordTypeId' <> p_source_record_type ->> 'recordTypeId' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  for field_entry in select value from pg_catalog.jsonb_array_elements(p_source_record_type -> 'fields') loop
    if pg_catalog.jsonb_typeof(field_entry) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_entry -> 'fieldId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(field_entry ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_entry -> 'type') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    field_id := field_entry ->> 'fieldId';
    field_kind := field_entry ->> 'type';
    if field_types ? field_id then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    semantic_type := case
      when field_kind = 'decimal_number' then 'decimal_number'
      when field_kind = 'money' then 'money'
      when field_kind = 'whole_number' then 'number'
      when field_kind = 'yes_no' then 'boolean'
      when field_kind = 'date' then 'date'
      when field_kind = 'date_time' then 'date_time'
      when field_kind = 'several_choices' then 'text_collection'
      when field_kind in ('table', 'attachment') then 'opaque_json'
      when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
      when field_kind = 'link_to_person' then 'organization_account_reference'
      when field_kind in ('calculation', 'total') then null
      when field_kind in (
        'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
        'email_address', 'phone_number', 'web_address'
      ) then 'text'
      else null end;
    if field_kind in ('calculation', 'total') then
      result_kind := field_entry #>> '{settings,resultType}';
      semantic_type := case
        when result_kind = 'decimal_number' then 'decimal_number'
        when result_kind = 'money' then 'money'
        when result_kind = 'whole_number' then 'number'
        when result_kind = 'yes_no' then 'boolean'
        when result_kind = 'date' then 'date'
        when result_kind = 'date_time' then 'date_time'
        when result_kind in ('text', 'choice') then 'text'
        else null end;
    end if;
    if semantic_type is null then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    field_types := field_types || pg_catalog.jsonb_build_object(field_id, semantic_type);
  end loop;

  declared_fields := '{}'::jsonb;
  for field_entry in select value from pg_catalog.jsonb_array_elements(p_saved_condition -> 'declaredFieldIds') loop
    if pg_catalog.jsonb_typeof(field_entry) is distinct from 'string'
      or not (field_types ? (field_entry #>> '{}'))
      or declared_fields ? (field_entry #>> '{}') then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    declared_fields := declared_fields || pg_catalog.jsonb_build_object(field_entry #>> '{}', true);
  end loop;

  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(p_field_values);
  if key_count <> pg_catalog.jsonb_array_length(p_saved_condition -> 'declaredFieldIds') then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  for supplied_key, supplied_value in select key, value from pg_catalog.jsonb_each(p_field_values) loop
    semantic_type := field_types ->> supplied_key;
    if not (declared_fields ? supplied_key)
      or not vortex_access.typed_condition_value_matches_internal(supplied_value, semantic_type, true)
      or (
        supplied_value <> 'null'::jsonb and semantic_type = 'decimal_number'
        and (
          pg_catalog.jsonb_typeof(supplied_value) <> 'string'
          or (supplied_value #>> '{}') !~ canonical_decimal
        )
      ) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
  end loop;

  for declaration in select value from pg_catalog.jsonb_array_elements(p_saved_condition -> 'parameters') loop
    if pg_catalog.jsonb_typeof(declaration) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(declaration);
    parameter_key := declaration ->> 'key';
    parameter_type := declaration ->> 'type';
    if key_count <> 2
      or parameter_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(parameter_key) > 40
      or parameter_type is null
      or not (
        parameter_type in (
          'text', 'number', 'boolean', 'date', 'date_time', 'organization_account_reference'
        )
        or parameter_type in ('decimal_number', 'money')
      )
      or parameter_types ? parameter_key then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(parameter_key, parameter_type);
    declaration_keys := pg_catalog.array_append(declaration_keys, parameter_key);
  end loop;

  for binding in select value from pg_catalog.jsonb_array_elements(scope_condition -> 'parameterBindings') loop
    if pg_catalog.jsonb_typeof(binding) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(binding);
    parameter_key := binding ->> 'key';
    parameter_type := parameter_types ->> parameter_key;
    if parameter_key is null or not (parameter_types ? parameter_key) or parameter_key = any(binding_keys) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    if binding ->> 'source' = 'current_organization_account_id' then
      if key_count <> 2 or parameter_type not in ('text', 'organization_account_reference') then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(
        parameter_key, p_current_organization_account_id::text
      );
    elsif binding ->> 'source' = 'literal' then
      if key_count <> 3 or not (binding ? 'value')
        or not vortex_access.typed_condition_value_matches_internal(binding -> 'value', parameter_type, false)
        or (parameter_type = 'decimal_number' and (
          pg_catalog.jsonb_typeof(binding -> 'value') <> 'string'
          or (binding ->> 'value') !~ canonical_decimal
        )) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(parameter_key, binding -> 'value');
    else
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    binding_keys := pg_catalog.array_append(binding_keys, parameter_key);
  end loop;
  if pg_catalog.cardinality(declaration_keys) <> pg_catalog.cardinality(binding_keys)
    or exists (
      select 1 from pg_catalog.unnest(declaration_keys) as declared(key)
      where not (declared.key = any(binding_keys))
    ) then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  with recursive nodes(node, depth) as (
    select p_saved_condition -> 'condition', 1
    union all
    select children.child, nodes.depth + 1
    from nodes
    cross join lateral (
      select child.value as child
      from pg_catalog.jsonb_array_elements(case
        when nodes.node ->> 'kind' in ('all', 'any')
          and pg_catalog.jsonb_typeof(nodes.node -> 'conditions') = 'array'
          then nodes.node -> 'conditions' else '[]'::jsonb end) as child(value)
      union all
      select nodes.node -> 'condition'
      where nodes.node ->> 'kind' = 'not'
        and pg_catalog.jsonb_typeof(nodes.node -> 'condition') = 'object'
    ) as children
  )
  select pg_catalog.max(depth), pg_catalog.sum(case when node ->> 'kind' = 'comparison'
    then case when node ->> 'operator' in ('is_empty', 'is_not_empty') then 1 else 2 end else 0 end)::integer
  into tree_depth, tree_operands from nodes;
  if tree_depth > 10 or tree_operands > 100 then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  perform vortex_access.evaluate_typed_condition_node_internal(
    p_saved_condition -> 'condition', field_types, p_field_values,
    parameter_types, parameter_values, true
  );
  return vortex_access.evaluate_typed_condition_node_internal(
    p_saved_condition -> 'condition', field_types, p_field_values,
    parameter_types, parameter_values, false
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
end
$_$;


reset role;
set local role vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  query_release_revision bigint;
  query_release_version text;
  query_contract_version text;
  query_content jsonb;
  query_item jsonb;
  type_module_root_id uuid;
  type_record_type_id uuid;
  type_release_revision bigint;
  type_content jsonb;
  record_type_item jsonb;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  installation := vortex_definition.read_current_active_installation();

  select (item.value ->> 'moduleReleaseRevision')::bigint
  into query_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = p_module_root_id;
  if query_release_revision is null then
    return null;
  end if;

  select release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version
  into query_content, query_release_version, query_contract_version
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  select item.value into query_item
  from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
  where pg_catalog.lower(item.value ->> 'queryId') = pg_catalog.lower(p_query_id::text)
  limit 1;
  -- No authored query has this identity: a record type of this Module, listed by its own.
  if query_item is null then
    select vortex_record.record_type_listing_query_internal(p_module_root_id, item.value)
    into query_item
    from pg_catalog.jsonb_array_elements(
      coalesce(query_content -> 'recordTypes', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_query_id::text)
    limit 1;
  end if;
  if query_item is null
    or query_item #>> '{recordType,state}' is distinct from 'resolved'
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,moduleRootId}', 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,recordTypeId}', 'uuid'), false) then
    return null;
  end if;
  type_module_root_id := (query_item #>> '{recordType,moduleRootId}')::uuid;
  type_record_type_id := (query_item #>> '{recordType,recordTypeId}')::uuid;

  -- The record type may belong to a declared dependency; it must be bound to
  -- this same installation at its own pinned release.
  select (item.value ->> 'moduleReleaseRevision')::bigint
  into type_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = type_module_root_id;
  if type_release_revision is null then
    return null;
  end if;

  if type_module_root_id = p_module_root_id then
    type_content := query_content;
  else
    select release.compilation_output #> '{canonical,content}'
    into type_content
    from vortex_definition.releases as release
    where release.root_id = type_module_root_id
      and release.release_revision = type_release_revision;
  end if;
  if pg_catalog.jsonb_typeof(type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(type_record_type_id::text)
  limit 1;
  if record_type_item is null
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_item ->> 'storageContractId', 'uuid'), false) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', type_record_type_id,
    'recordTypeModuleRootId', type_module_root_id,
    'recordType', record_type_item
  );
end
$$;

create or replace function vortex_record.resolve_preview_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  module_bindings jsonb;
  storage_identities jsonb;
  preview_installation_id uuid;
  query_binding jsonb;
  query_binding_count bigint;
  query_release_revision_text text;
  query_release_revision bigint;
  query_compilation_output jsonb;
  query_content jsonb;
  query_release_version text;
  query_validation_contract_version text;
  query_source_contract_version text;
  query_item jsonb;
  query_match_count bigint := 0;
  record_type_module_root_id_text text;
  record_type_module_root_id uuid;
  record_type_id_text text;
  record_type_id uuid;
  record_type_binding jsonb;
  record_type_binding_count bigint;
  record_type_release_revision_text text;
  record_type_release_revision bigint;
  record_type_compilation_output jsonb;
  record_type_content jsonb;
  record_type_validation_contract_version text;
  record_type_source_contract_version text;
  record_type_item jsonb;
  record_type_match_count bigint := 0;
  release_storage_contract_id_text text;
  release_storage_contract_id uuid;
  storage_identity jsonb;
  storage_identity_count bigint := 0;
  preview_storage_contract_id_text text;
  preview_storage_contract_id uuid;
  preview_storage_identity_count bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  -- The address is transaction-local. This helper validates the human actor,
  -- organisation account, Application, ownership and expiry before returning
  -- the pinned preview; a missing or refused address never selects live state.
  installation := vortex_record.read_current_preview_installation_internal();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) is distinct from 'object'
    or installation ? 'outcome'
    or not coalesce(pg_catalog.pg_input_is_valid(
      installation ->> 'previewInstallationId', 'uuid'
    ), false) then
    return null;
  end if;
  preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
  if preview_installation_id = nil_uuid then
    return null;
  end if;

  module_bindings := installation -> 'moduleBindings';
  storage_identities := installation -> 'storageIdentities';
  if pg_catalog.jsonb_typeof(module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_typeof(storage_identities) is distinct from 'array' then
    return null;
  end if;

  -- Resolve the query only through one exact Module pin in this preview.
  select pg_catalog.count(*)
  into query_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding_count <> 1 then
    return null;
  end if;
  select item.value into query_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  query_release_revision_text := query_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(query_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  query_release_revision := query_release_revision_text::bigint;
  if query_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  select release.compilation_output, release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version,
    release.source_contract_version
  into query_compilation_output, query_content, query_release_version, query_validation_contract_version,
    query_source_contract_version
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or query_source_contract_version is distinct from query_validation_contract_version
    or query_compilation_output #>> '{kind}' is distinct from 'module'
    or query_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or query_compilation_output #>> '{validationContractVersion}'
      is distinct from query_validation_contract_version
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  for query_item in
    select item.value
    from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
    where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text
  loop
    query_match_count := query_match_count + 1;
  end loop;
  if query_match_count > 1 then
    return null;
  end if;
  if query_match_count = 1 then
    select item.value into query_item
    from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
    where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text;
  else
    -- No authored query has this identity: one record type of this Module, listed by its own.
    if pg_catalog.jsonb_typeof(query_content -> 'recordTypes') is distinct from 'array'
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(query_content -> 'recordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') = p_query_id::text
      ) <> 1 then
      return null;
    end if;
    select vortex_record.record_type_listing_query_internal(p_module_root_id, item.value)
    into query_item
    from pg_catalog.jsonb_array_elements(query_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = p_query_id::text;
  end if;
  if pg_catalog.jsonb_typeof(query_item) is distinct from 'object'
    or query_item #>> '{recordType,state}' is distinct from 'resolved' then
    return null;
  end if;

  record_type_module_root_id_text := query_item #>> '{recordType,moduleRootId}';
  record_type_id_text := query_item #>> '{recordType,recordTypeId}';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_module_root_id_text, 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_id_text, 'uuid'), false) then
    return null;
  end if;
  record_type_module_root_id := record_type_module_root_id_text::uuid;
  record_type_id := record_type_id_text::uuid;
  if record_type_module_root_id = nil_uuid or record_type_id = nil_uuid then
    return null;
  end if;

  -- The referenced record type may be in a dependency, but that dependency
  -- must also have one active pin in this same preview installation.
  select pg_catalog.count(*)
  into record_type_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding_count <> 1 then
    return null;
  end if;
  select item.value into record_type_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  record_type_release_revision_text := record_type_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  record_type_release_revision := record_type_release_revision_text::bigint;
  if record_type_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  if record_type_module_root_id = p_module_root_id then
    if record_type_release_revision <> query_release_revision then
      return null;
    end if;
    record_type_compilation_output := query_compilation_output;
    record_type_content := query_content;
    record_type_validation_contract_version := query_validation_contract_version;
    record_type_source_contract_version := query_source_contract_version;
  else
    select release.compilation_output, release.compilation_output #> '{canonical,content}',
      release.validation_contract_version, release.source_contract_version
    into record_type_compilation_output, record_type_content, record_type_validation_contract_version,
      record_type_source_contract_version
    from vortex_definition.runtime_releases as release
    where release.root_id = record_type_module_root_id
      and release.release_revision = record_type_release_revision;
    if not found then
      return null;
    end if;
  end if;
  if record_type_validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or record_type_source_contract_version is distinct from record_type_validation_contract_version
    or record_type_compilation_output #>> '{kind}' is distinct from 'module'
    or record_type_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from record_type_module_root_id::text
    or record_type_compilation_output #>> '{validationContractVersion}'
      is distinct from record_type_validation_contract_version
    or pg_catalog.jsonb_typeof(record_type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  for record_type_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
  loop
    record_type_match_count := record_type_match_count + 1;
  end loop;
  if record_type_match_count <> 1 then
    return null;
  end if;
  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text;
  if pg_catalog.jsonb_typeof(record_type_item) is distinct from 'object'
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(
      record_type_item ->> 'storageContractId', 'uuid'
    ), false) then
    return null;
  end if;
  release_storage_contract_id_text := record_type_item ->> 'storageContractId';
  release_storage_contract_id := release_storage_contract_id_text::uuid;
  if release_storage_contract_id = nil_uuid then
    return null;
  end if;

  -- Match one storage identity against both exact release pins and the
  -- declaration's release storage contract; duplicates or malformed mappings
  -- never choose an arbitrary preview table.
  for storage_identity in
    select item.value
    from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'object'
      and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
      and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
      and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
      and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text
  loop
    storage_identity_count := storage_identity_count + 1;
  end loop;
  if storage_identity_count <> 1 then
    return null;
  end if;
  select item.value into storage_identity
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
    and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
    and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
    and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text;
  preview_storage_contract_id_text := storage_identity ->> 'previewStorageContractId';
  if not coalesce(pg_catalog.pg_input_is_valid(preview_storage_contract_id_text, 'uuid'), false) then
    return null;
  end if;
  preview_storage_contract_id := preview_storage_contract_id_text::uuid;
  if preview_storage_contract_id = nil_uuid then
    return null;
  end if;
  select pg_catalog.count(*)
  into preview_storage_identity_count
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'previewStorageContractId')
      = preview_storage_contract_id::text;
  if preview_storage_identity_count <> 1 then
    return null;
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = preview_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.module_root_id is distinct from record_type_module_root_id
    or catalogue_row.record_type_id is distinct from record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.first_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.last_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.record_type_definition ->> 'storageContractId'
      is distinct from preview_storage_contract_id::text
    or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
      is distinct from record_type_id::text
    or catalogue_row.record_type_definition ->> 'storageScope'
      is distinct from (record_type_item ->> 'storageScope') then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id,
    'moduleRootId', p_module_root_id,
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', record_type_id,
    'recordTypeModuleRootId', record_type_module_root_id,
    'recordTypeModuleReleaseRevision', record_type_release_revision,
    'releaseStorageContractId', release_storage_contract_id,
    'previewStorageContractId', preview_storage_contract_id,
    'storageScope', record_type_item ->> 'storageScope',
    'recordType', record_type_item
  );
end
$function$;

create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  plan jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  declaration jsonb;
  field_bounds jsonb;
  ownership_mode text;
  access_routes record;
  alternative jsonb;
  route jsonb;
  route_terms text[];
  route_sql text;
  alternative_terms text[] := array[]::text[];
  condition_sql text;
  condition_entry jsonb;
  condition_params jsonb;
  condition_field_types jsonb;
  condition_field_columns jsonb;
  condition_field_database_types jsonb;
  condition_field_definitions jsonb;
  condition_parameter_types jsonb;
  condition_parameter_values jsonb;
  condition_referenced_ids text[];
  declared_condition_ids text[];
  field_item jsonb;
  declaration_item jsonb;
  binding_item jsonb;
  field_id text;
  field_kind text;
  semantic_type text;
  column_entry jsonb;
  database_value_type text;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  -- Narrowing only. A refusal or unsupported condition named below leaves the
  -- scan less selective, so the exact per-row decision is still what decides
  -- what a caller reads. Any other failure propagates with its cause: it is
  -- never turned into an unrestricted scan.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  ownership_mode := target_meta ->> 'ownershipMode';

  -- The declaration the record loader builds for a read: every record-scoped
  -- read permission declared for this exact record type by the context
  -- Application or the record type's own Module, in canonical order.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(plan -> 'permissions') as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = 'read'
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
    );

  if required_permissions is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], 'true'::text, '[]'::jsonb;
    return;
  end if;

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', context_application_root_id
    ),
    'requiredPermissions', required_permissions,
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', (target_meta ->> 'moduleRootId')::uuid,
      'recordTypeId', p_record_type_id,
      'storageContractId', (target_meta ->> 'storageContractId')::uuid,
      'storageScope', target_meta ->> 'storageScope'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  -- The owner, owner-group and direct-share routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits. A refused access context yields no fields, so the scan
  -- pushes neither an order nor a filter on a value it cannot prove is visible;
  -- any other failure propagates.
  begin
    field_bounds := vortex_access.resolve_record_read_field_bounds_internal(declaration);
  exception
    when sqlstate '42501' then
      get stacked diagnostics failure_sqlstate = returned_sqlstate,
        failure_message = message_text;
      raise warning 'Record read scan field bounds were refused: SQLSTATE %, %',
        failure_sqlstate, failure_message;
      field_bounds := '{}'::jsonb;
  end;

  -- Those fields may drive the scan only when every row the scan examines is a
  -- row the exact decision admits: an unconditioned all-records alternative
  -- admits every active record, and a restricted plan examines only owned and
  -- directly shared records, which its routes admit unless a saved condition
  -- narrows them. Otherwise the scan also examines rows the reader cannot read,
  -- whose every value is hidden, so no field is readable for the scan.
  readable_field_ids_value := case
    when (field_bounds -> 'coversAllRecords') = 'true'::jsonb
      or (access_routes.restricted and (field_bounds -> 'conditionFree') = 'true'::jsonb)
    then coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    )
    else array[]::text[]
  end;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- Every eligible alternative contributes one term: its route's exact stored
  -- predicate (or true when the route has no exact form) AND its saved
  -- condition compiled into the same scan. The terms are OR-ed deliberately:
  -- the exact decision admits a record through any one alternative, so the
  -- scan must keep every row any of them admits. The result only removes rows
  -- the exact per-row decision below would refuse; every row the scan returns
  -- still goes through read_record, so it cannot widen a result.
  if access_routes.alternatives is null
    or pg_catalog.jsonb_typeof(access_routes.alternatives) is distinct from 'array' then
    access_predicate_value := 'true';
  elsif pg_catalog.jsonb_array_length(access_routes.alternatives) = 0 then
    -- No eligible alternative admits any record.
    access_predicate_value := 'false';
  else
    for alternative in
      select item.value
      from pg_catalog.jsonb_array_elements(access_routes.alternatives) as item(value)
    loop
      route_terms := array[]::text[];
      for route in
        select item.value
        from pg_catalog.jsonb_array_elements(alternative -> 'routes') as item(value)
      loop
        case route ->> 'kind'
          when 'ownership' then
            if ownership_mode = 'organization_account' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_organisation_account_id = $6');
            elsif ownership_mode = 'group' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_group_id = any ($7)');
            else
              -- Inherited ownership is reached only by a current-edge chase.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            end if;
          when 'direct_share' then
            if access_routes.shared_record_ids is null then
              -- More current shares than one query carries: not narrowed.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            else
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.record_id = any ($8)');
            end if;
          else
            -- all_records admits every record; a relationship route is a
            -- current-edge chase. Neither has an exact stored predicate.
            route_terms := pg_catalog.array_append(route_terms, 'true');
        end case;
      end loop;

      if pg_catalog.cardinality(route_terms) = 0 then
        route_sql := 'false';
      elsif 'true' = any (route_terms) then
        route_sql := 'true';
      else
        route_sql := '(' || pg_catalog.array_to_string(route_terms, ' or ') || ')';
      end if;

      -- A saved condition narrows every route of its alternative, including an
      -- all-records route. It is compiled with the exact-semantics type map and
      -- the alternative's own bound parameters; anything the compiler cannot
      -- express exactly is left as true, so the per-row decision still decides.
      condition_sql := null;
      condition_params := '[]'::jsonb;
      if alternative ? 'savedCondition'
        and pg_catalog.jsonb_typeof(alternative -> 'savedCondition') = 'object' then
        condition_entry := null;
        select entry.value into condition_entry
        from pg_catalog.jsonb_array_elements(plan -> 'sharingConditions') as entry(value)
        where (entry.value ->> 'conditionId')
            = (alternative -> 'savedCondition' ->> 'conditionId')
          and (entry.value ->> 'publishedRevision')::numeric
            = (alternative -> 'savedCondition' ->> 'publishedRevision')::numeric
          and (entry.value ->> 'contractFingerprint')
            = (alternative -> 'savedCondition' ->> 'contractFingerprint')
          and pg_catalog.lower(entry.value ->> 'sourceRecordTypeId')
            = pg_catalog.lower(p_record_type_id::text)
        limit 1;

        if condition_entry is not null then
          condition_field_types := '{}'::jsonb;
          condition_field_columns := '{}'::jsonb;
          condition_field_database_types := '{}'::jsonb;
          condition_field_definitions := '{}'::jsonb;
          for field_item in
            select item.value
            from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as item(value)
          loop
            field_id := pg_catalog.lower(field_item ->> 'fieldId');
            column_entry := target_meta -> 'columns' -> field_id;
            if column_entry is not null then
              field_kind := field_item ->> 'type';
              -- The exact (current Module contract) semantics of the
              -- saved-condition evaluator: calculation and total fields have no
              -- fixed stored value here and stay out of the map.
              semantic_type := case
                when field_kind = 'decimal_number' then 'decimal_number'
                when field_kind = 'money' then 'money'
                when field_kind = 'whole_number' then 'number'
                when field_kind = 'yes_no' then 'boolean'
                when field_kind = 'date' then 'date'
                when field_kind = 'date_time' then 'date_time'
                when field_kind = 'several_choices' then 'text_collection'
                when field_kind in ('table', 'attachment') then 'opaque_json'
                when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
                when field_kind = 'link_to_person' then 'organization_account_reference'
                when field_kind in (
                  'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
                  'email_address', 'phone_number', 'web_address'
                ) then 'text'
                else null end;
              if semantic_type is not null then
                condition_field_types := condition_field_types
                  || pg_catalog.jsonb_build_object(field_id, semantic_type);
                condition_field_columns := condition_field_columns
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'token');
                condition_field_database_types := condition_field_database_types
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'databaseValueType');
                condition_field_definitions := condition_field_definitions
                  || pg_catalog.jsonb_build_object(
                    field_id, pg_catalog.jsonb_build_object('filterable', true, 'type', field_kind));
              end if;
            end if;
          end loop;

          select coalesce(
            pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
          into condition_referenced_ids
          from pg_catalog.jsonb_path_query(
            condition_entry -> 'condition', 'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value);
          select coalesce(
            pg_catalog.array_agg(pg_catalog.lower(declared.value #>> '{}')), array[]::text[])
          into declared_condition_ids
          from pg_catalog.jsonb_array_elements(
            condition_entry -> 'declaredFieldIds'
          ) as declared(value);

          supported := true;
          foreach field_id in array condition_referenced_ids loop
            field_id := pg_catalog.lower(field_id);
            if not (condition_field_types ? field_id)
              or not (condition_field_columns ? field_id)
              or not (condition_field_database_types ? field_id)
              or not (field_id = any (declared_condition_ids)) then
              supported := false;
              exit;
            end if;
            semantic_type := condition_field_types ->> field_id;
            database_value_type := condition_field_database_types ->> field_id;
            if not (
              (semantic_type = 'boolean' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              -- A version-1 decimal field is a number to the condition engine
              -- but is projected as decimal text, which that engine refuses;
              -- only a whole number is stored as the number it compares.
              or (semantic_type = 'number' and database_value_type = 'integer')
              or (semantic_type = 'date' and database_value_type = 'date')
              or (semantic_type = 'date_time' and database_value_type = 'timestamp_with_time_zone')
            ) then
              supported := false;
              exit;
            end if;
          end loop;

          if supported then
            condition_parameter_types := '{}'::jsonb;
            condition_parameter_values := '{}'::jsonb;
            for declaration_item in
              select item.value
              from pg_catalog.jsonb_array_elements(condition_entry -> 'parameters') as item(value)
            loop
              condition_parameter_types := condition_parameter_types
                || pg_catalog.jsonb_build_object(
                  declaration_item ->> 'key', declaration_item ->> 'type');
            end loop;
            for binding_item in
              select item.value
              from pg_catalog.jsonb_array_elements(
                alternative -> 'savedCondition' -> 'parameterBindings'
              ) as item(value)
            loop
              if binding_item ->> 'source' = 'current_organization_account_id' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', context_account_id::text);
              elsif binding_item ->> 'source' = 'literal' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', binding_item -> 'value');
              else
                supported := false;
                exit;
              end if;
            end loop;
          end if;

          if supported then
            parameter_offset := pg_catalog.jsonb_array_length(access_parameters_accum);
            begin
              compiled := vortex_record.compile_query_filter_internal(
                condition_entry -> 'condition',
                condition_field_types,
                condition_field_columns,
                condition_field_database_types,
                condition_field_definitions,
                '{}'::jsonb,
                condition_parameter_types,
                condition_parameter_values,
                10,
                parameter_offset
              );
              condition_sql := compiled ->> 'predicate';
              condition_params := coalesce(compiled -> 'parameters', '[]'::jsonb);
            exception
              -- 22023 is the compiler's refusal of a condition it cannot express
              -- exactly; the condition is then left as true. Any other failure
              -- propagates.
              when sqlstate '22023' then
                get stacked diagnostics failure_sqlstate = returned_sqlstate,
                  failure_message = message_text;
                raise warning 'Record read scan condition was not pushed: SQLSTATE %, %',
                  failure_sqlstate, failure_message;
                condition_sql := null;
                condition_params := '[]'::jsonb;
            end;
          end if;

          -- Keep every compiled parameter even when nothing was pushed, so the
          -- next alternative's offsets stay aligned with the JSON array passed
          -- to the scan.
          access_parameters_accum := access_parameters_accum || condition_params;
        end if;
      end if;

      if condition_sql is null then
        alternative_terms := pg_catalog.array_append(alternative_terms, route_sql);
      elsif route_sql = 'true' then
        alternative_terms := pg_catalog.array_append(alternative_terms, condition_sql);
      else
        alternative_terms := pg_catalog.array_append(
          alternative_terms, '(' || route_sql || ' and ' || condition_sql || ')');
      end if;
    end loop;

    if 'true' = any (alternative_terms) then
      access_predicate_value := 'true';
      access_parameters_value := '[]'::jsonb;
    else
      access_predicate_value := '('
        || pg_catalog.array_to_string(alternative_terms, ' or ') || ')';
      access_parameters_value := access_parameters_accum;
    end if;
  end if;

  return query select
    access_routes.restricted,
    access_routes.owner_account_id,
    access_routes.owner_group_ids,
    access_routes.shared_record_ids,
    readable_field_ids_value,
    access_predicate_value,
    access_parameters_value;
  return;
end
$function$;

reset role;
