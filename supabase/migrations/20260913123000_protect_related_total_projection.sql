-- #48 Stage 2A: a total is a derived disclosure, not an independent field
-- grant.  Keep this work at the record adapter boundary: the request role is
-- never given a reader for installed definitions, edges, or source rows.
begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- Returns the exact source type and source field identifiers a total needs.
-- The supplied record types are the installed, pin-set facts already loaded by
-- the adapter.  A malformed or ambiguous relationship fails closed.
create function vortex_record.total_dependency_contract_internal(
  p_record_types jsonb,
  p_target_record_type_id uuid,
  p_total_field jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  relationship_id_value uuid;
  relationship_value jsonb;
  source_type_id uuid;
  source_ids jsonb := '[]'::jsonb;
  source_field_id text;
begin
  if p_target_record_type_id is null
    or pg_catalog.jsonb_typeof(p_record_types) <> 'array'
    or pg_catalog.jsonb_typeof(p_total_field) <> 'object'
    or p_total_field ->> 'type' <> 'total'
    or not pg_catalog.pg_input_is_valid(
      p_total_field #>> '{settings,relationshipId}', 'uuid'
    ) then
    return null;
  end if;
  relationship_id_value := (p_total_field #>> '{settings,relationshipId}')::uuid;

  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(p_record_types) as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(record_type.value -> 'relationships', '[]'::jsonb)
  ) as item(value)
  where pg_catalog.lower(item.value ->> 'relationshipId') =
      pg_catalog.lower(relationship_id_value::text)
    and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
      pg_catalog.lower(p_target_record_type_id::text);
  if relationship_value is null
    or not pg_catalog.pg_input_is_valid(
      relationship_value ->> 'fromRecordTypeId', 'uuid'
    ) then
    return null;
  end if;
  source_type_id := (relationship_value ->> 'fromRecordTypeId')::uuid;

  if p_total_field #>> '{settings,operation}' <> 'count' then
    source_field_id := p_total_field #>> '{settings,fieldId}';
    if not pg_catalog.pg_input_is_valid(source_field_id, 'uuid') then
      return null;
    end if;
    source_ids := source_ids || pg_catalog.jsonb_build_array(
      pg_catalog.lower(source_field_id)
    );
  end if;

  -- Condition leaves are field operands.  The compiler has already validated
  -- their shape; repeat only the exact extraction here so malformed facts
  -- cannot widen a projection.
  source_ids := source_ids || coalesce((
    with recursive nodes(value) as (
      select p_total_field -> 'settings' -> 'filter'
      union all
      select child.value
      from nodes
      cross join lateral (
        select entry.value from pg_catalog.jsonb_each(nodes.value) as entry(key, value)
        where pg_catalog.jsonb_typeof(nodes.value) = 'object'
        union all
        select entry.value from pg_catalog.jsonb_array_elements(nodes.value) as entry(value)
        where pg_catalog.jsonb_typeof(nodes.value) = 'array'
      ) as child
      where nodes.value is not null
    )
    select pg_catalog.jsonb_agg(pg_catalog.lower(value ->> 'fieldId') order by pg_catalog.lower(value ->> 'fieldId'))
    from nodes
    where value ->> 'source' = 'field'
      and pg_catalog.pg_input_is_valid(value ->> 'fieldId', 'uuid')
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'relationshipId', relationship_id_value,
    'sourceRecordTypeId', source_type_id,
    'sourceFieldIds', coalesce((
      select pg_catalog.jsonb_agg(distinct entry.value order by entry.value)
      from pg_catalog.jsonb_array_elements_text(source_ids) as entry(value)
    ), '[]'::jsonb)
  );
end
$function$;

-- Pure projection filter.  `p_total_inputs_readable` is built only by the
-- private helper below; it maps each target total field id to true/false.
create function vortex_record.filter_derived_readable_field_ids(
  p_record_types jsonb,
  p_record_type_id uuid,
  p_readable_field_ids jsonb,
  p_total_inputs_readable jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  record_type_value jsonb;
  field_value jsonb;
  field_id text;
  dependency_id text;
  readable_ids text[] := array[]::text[];
  allowed_ids text[] := array[]::text[];
  changed boolean := true;
  dependencies_allowed boolean;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_record_types) <> 'array'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_total_inputs_readable) <> 'object' then
    return '[]'::jsonb;
  end if;
  select item.value into record_type_value
  from pg_catalog.jsonb_array_elements(p_record_types) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if record_type_value is null
    or pg_catalog.jsonb_typeof(record_type_value -> 'fields') <> 'array' then
    return '[]'::jsonb;
  end if;
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')),
    array[]::text[])
  into readable_ids
  from pg_catalog.jsonb_array_elements(p_readable_field_ids) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';

  for field_value in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    field_id := pg_catalog.lower(field_value ->> 'fieldId');
    if field_value ->> 'type' not in ('calculation', 'total')
      and field_id = any (readable_ids) then
      allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
    end if;
  end loop;
  while changed loop
    changed := false;
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      where item.value ->> 'type' in ('calculation', 'total')
    loop
      field_id := pg_catalog.lower(field_value ->> 'fieldId');
      if field_id <> all (readable_ids) or field_id = any (allowed_ids) then
        continue;
      end if;
      if field_value ->> 'type' = 'total' then
        dependencies_allowed := (p_total_inputs_readable ->> field_id) = 'true';
      else
        dependencies_allowed := true;
        for dependency_id in
          select pg_catalog.lower(item.value #>> '{}')
          from pg_catalog.jsonb_array_elements(
            coalesce(field_value -> 'settings' -> 'dependencyFieldIds', '[]'::jsonb)
          ) as item(value)
        loop
          if dependency_id <> all (allowed_ids) then
            dependencies_allowed := false;
            exit;
          end if;
        end loop;
      end if;
      if dependencies_allowed then
        allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
        changed := true;
      end if;
    end loop;
  end loop;
  return coalesce((
    select pg_catalog.jsonb_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements(p_readable_field_ids) with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and pg_catalog.lower(item.value #>> '{}') = any (allowed_ids)
  ), '[]'::jsonb);
end
$function$;

-- Reads one exact related source only through the adapter's existing facts
-- loader and access decision.  NULL means either the source record is not
-- readable or the graph returns to a record already on this disclosure path.
create function vortex_record.read_derived_field_ids_for_exact_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_seen_record_keys jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  record_key text;
begin
  if p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_seen_record_keys) <> 'array' then
    return null;
  end if;
  record_key := pg_catalog.lower(p_record_type_id::text) || ':' || pg_catalog.lower(p_record_id::text);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements_text(p_seen_record_keys) as key(value)
    where key.value = record_key
  ) then
    return null;
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null);
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return null;
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  return vortex_record.project_derived_readable_field_ids_internal(
    loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds', p_seen_record_keys
  );
end
$function$;

-- Tests every row contributing to one total.  The edge query is bounded by
-- the exact relationship, target storage contract, record and organisation of
-- the already-authorized target; it is not a general source-row reader.
create function vortex_record.total_inputs_readable_internal(
  p_loaded jsonb,
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_total_field jsonb,
  p_seen_record_keys jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  contract_value jsonb;
  source_projection jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  required_field_id text;
begin
  contract_value := vortex_record.total_dependency_contract_internal(
    p_loaded -> 'facts' -> 'recordTypes', p_target_record_type_id, p_total_field
  );
  if contract_value is null
    or pg_catalog.jsonb_typeof(p_seen_record_keys) <> 'array' then
    return false;
  end if;
  for edge_row in
    select edge.* from vortex_record.relationship_edges as edge
    where edge.relationship_id = (contract_value ->> 'relationshipId')::uuid
      and edge.to_storage_contract_id =
        (p_loaded -> 'facts' -> 'binding' ->> 'storageContractId')::uuid
      and edge.to_record_id = p_target_record_id
      and edge.to_organisation_id = (p_loaded -> 'context' ->> 'organizationId')::uuid
  loop
    source_projection := vortex_record.read_derived_field_ids_for_exact_record_internal(
      (contract_value ->> 'sourceRecordTypeId')::uuid,
      edge_row.from_record_id,
      p_seen_record_keys
    );
    if source_projection is null then
      return false;
    end if;
    for required_field_id in
      select item.value from pg_catalog.jsonb_array_elements_text(
        contract_value -> 'sourceFieldIds'
      ) as item(value)
    loop
      if not (source_projection ? required_field_id) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end
$function$;

-- The only composition point.  It starts from one already-authorized target
-- bound and recursively proves the exact inputs of each displayed total.
create function vortex_record.project_derived_readable_field_ids_internal(
  p_loaded jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_readable_field_ids jsonb,
  p_seen_record_keys jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  field_value jsonb;
  total_inputs jsonb := '{}'::jsonb;
  record_key text;
  seen_with_current jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_loaded -> 'facts' -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_seen_record_keys) <> 'array' then
    return null;
  end if;
  record_key := pg_catalog.lower(p_record_type_id::text) || ':' || pg_catalog.lower(p_record_id::text);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements_text(p_seen_record_keys) as key(value)
    where key.value = record_key
  ) then
    return null;
  end if;
  seen_with_current := p_seen_record_keys || pg_catalog.jsonb_build_array(record_key);
  for field_value in
    select field.value
    from pg_catalog.jsonb_array_elements(p_loaded -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'total'
  loop
    total_inputs := total_inputs || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_value ->> 'fieldId'),
      vortex_record.total_inputs_readable_internal(
        p_loaded, p_record_type_id, p_record_id, field_value, seen_with_current
      )
    );
  end loop;
  return vortex_record.filter_derived_readable_field_ids(
    p_loaded -> 'facts' -> 'recordTypes', p_record_type_id,
    p_readable_field_ids, total_inputs
  );
end
$function$;

alter function vortex_record.total_dependency_contract_internal(jsonb, uuid, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.filter_derived_readable_field_ids(jsonb, uuid, jsonb, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.read_derived_field_ids_for_exact_record_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.project_derived_readable_field_ids_internal(jsonb, uuid, uuid, jsonb, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.total_dependency_contract_internal(jsonb, uuid, jsonb),
  vortex_record.filter_derived_readable_field_ids(jsonb, uuid, jsonb, jsonb),
  vortex_record.read_derived_field_ids_for_exact_record_internal(uuid, uuid, jsonb),
  vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb),
  vortex_record.project_derived_readable_field_ids_internal(jsonb, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.total_dependency_contract_internal(jsonb, uuid, jsonb),
  vortex_record.filter_derived_readable_field_ids(jsonb, uuid, jsonb, jsonb),
  vortex_record.read_derived_field_ids_for_exact_record_internal(uuid, uuid, jsonb),
  vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb),
  vortex_record.project_derived_readable_field_ids_internal(jsonb, uuid, uuid, jsonb, jsonb)
  to vortex_record_adapter;

-- Preserve one projection boundary for direct reads and save receipts.
create or replace function vortex_record.read_record(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null);
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object('readableFieldIds',
    vortex_record.project_derived_readable_field_ids_internal(
      loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds', '[]'::jsonb
    )
  );
  columns_value := loaded -> 'columns';
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, loaded -> 'fieldValues' -> field_id);
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber', 'values', values_value);
end
$function$;
alter function vortex_record.read_record(uuid, uuid) owner to vortex_record_adapter;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
