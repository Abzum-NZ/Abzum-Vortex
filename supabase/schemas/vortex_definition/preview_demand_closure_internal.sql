create or replace function vortex_definition.preview_demand_closure_internal(
  p_preview_installation_id uuid,
  p_demand jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row vortex_definition.preview_installations%rowtype;
  live_plan jsonb;
  module_item jsonb;
  record_type_item jsonb;
  relationship_item jsonb;
  field_item jsonb;
  demand_item jsonb;
  path_item jsonb;
  step_item jsonb;
  permission_item jsonb;
  route_item jsonb;
  ends jsonb;
  storage_ids text[];
  definitions jsonb := '{}'::jsonb;
  -- Every relationship of the preview's record types and of the live plan, by id: the record type
  -- that declares it and each record type it may point to.
  relationships jsonb := '{}'::jsonb;
  derived_ids text[] := array[]::text[];
  totals_over jsonb := '{}'::jsonb;
  pending text[] := array[]::text[];
  closure text[] := array[]::text[];
  current_id text;
  demanded_id text;
begin
  select preview.* into strict preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id;
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(identity.value ->> 'recordTypeId')),
      array[]::text[])
  into storage_ids
  from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value);

  if pg_catalog.jsonb_typeof(p_demand) is distinct from 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_demand) as key(value)
      where key.value <> 'recordTypes')
    or pg_catalog.jsonb_typeof(p_demand -> 'recordTypes') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_demand -> 'recordTypes') not between 1 and 201 then
    raise exception using errcode = '22023', message = 'Preview demand is invalid';
  end if;
  for demand_item in
    select item.value from pg_catalog.jsonb_array_elements(p_demand -> 'recordTypes') as item(value)
  loop
    -- A demand names one of the preview's own record types, the fields its visible readers show
    -- and the relationship paths their predicates and sorts follow.
    if pg_catalog.jsonb_typeof(demand_item) is distinct from 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(demand_item) as key(value)
        where key.value not in ('recordTypeId', 'fieldIds', 'relationshipPaths'))
      or not vortex_platform.is_non_nil_uuid(demand_item ->> 'recordTypeId')
      or pg_catalog.jsonb_typeof(demand_item -> 'fieldIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(demand_item -> 'fieldIds') > 500
      or exists (select 1 from pg_catalog.jsonb_array_elements(demand_item -> 'fieldIds') as id(value)
        where not vortex_platform.is_non_nil_uuid(id.value #>> '{}'))
      or pg_catalog.jsonb_typeof(demand_item -> 'relationshipPaths') is distinct from 'array'
      or pg_catalog.jsonb_array_length(demand_item -> 'relationshipPaths') > 50
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(demand_item -> 'relationshipPaths') as path(value)
        where pg_catalog.jsonb_typeof(path.value) is distinct from 'array'
          or pg_catalog.jsonb_array_length(path.value) not between 1 and 8
          or exists (select 1 from pg_catalog.jsonb_array_elements(path.value) as step(value)
            where not vortex_platform.is_non_nil_uuid(step.value #>> '{}'))
      )
      or not pg_catalog.lower(demand_item ->> 'recordTypeId') = any (storage_ids) then
      raise exception using errcode = '22023', message = 'Preview demand is invalid';
    end if;
  end loop;

  -- The record types the preview runs, read from its own releases.
  for module_item in
    select item.value
    from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
        p_preview_installation_id, (module_item ->> 'moduleRootId')::uuid,
        (module_item ->> 'moduleReleaseRevision')::bigint
      )) as item(value)
      where not item.value ? 'systemProjection'
    loop
      current_id := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      definitions := definitions || pg_catalog.jsonb_build_object(current_id, record_type_item);
      -- The same fields a derived-field backfill works out: totals and stored calculations.
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          or (field.value ->> 'type' = 'calculation'
            and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
      ) then
        derived_ids := derived_ids || current_id;
      end if;
      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'relationships', '[]'::jsonb))
          as item(value)
      loop
        relationships := relationships || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'from', current_id,
            'fromFieldId', pg_catalog.lower(relationship_item ->> 'fromFieldId'),
            'to', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.lower(target.value ->> 'recordTypeId'))
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else coalesce(relationship_item -> 'toRecordTypes', '[]'::jsonb)
                end
              ) as target(value)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;
  end loop;

  -- The builder's live access plan decides which records are copied; the relationships it follows
  -- to decide a record type's records bring their other record types along.
  live_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  for relationship_item in
    select item.value from pg_catalog.jsonb_each(coalesce(live_plan -> 'relationships', '{}'::jsonb))
      as item(key, value)
    where not relationships ? item.key
  loop
    relationships := relationships || pg_catalog.jsonb_build_object(
      pg_catalog.lower(relationship_item ->> 'relationshipId'),
      pg_catalog.jsonb_build_object(
        'from', pg_catalog.lower(relationship_item ->> 'fromRecordTypeId'),
        'to', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(target.value ->> 'recordTypeId'))
          from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        ), '[]'::jsonb)
      )
    );
  end loop;

  -- Which record types total over each record type, for the seed to work their totals out again.
  for current_id, record_type_item in
    select item.key, item.value from pg_catalog.jsonb_each(definitions) as item(key, value)
  loop
    for field_item in
      select field.value
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
    loop
      demanded_id := relationships -> pg_catalog.lower(field_item #>> '{settings,relationshipId}')
        ->> 'from';
      if demanded_id is not null then
        totals_over := totals_over || pg_catalog.jsonb_build_object(demanded_id,
          coalesce(totals_over -> demanded_id, '[]'::jsonb) || pg_catalog.to_jsonb(current_id));
      end if;
    end loop;
  end loop;

  -- Each demanded type, the targets of its demanded relationship fields, and the record types on
  -- the relationship paths its visible query follows.
  for demand_item in
    select item.value from pg_catalog.jsonb_array_elements(p_demand -> 'recordTypes') as item(value)
  loop
    demanded_id := pg_catalog.lower(demand_item ->> 'recordTypeId');
    pending := pending || demanded_id;
    for relationship_item in
      select item.value from pg_catalog.jsonb_each(relationships) as item(key, value)
      where item.value ->> 'from' = demanded_id
        and item.value ->> 'fromFieldId' in (
          select pg_catalog.lower(id.value #>> '{}')
          from pg_catalog.jsonb_array_elements(demand_item -> 'fieldIds') as id(value)
        )
    loop
      pending := pending || array(
        select target.value from pg_catalog.jsonb_array_elements_text(relationship_item -> 'to')
          as target(value));
    end loop;
    for path_item in
      select item.value from pg_catalog.jsonb_array_elements(demand_item -> 'relationshipPaths')
        as item(value)
    loop
      for step_item in
        select step.value from pg_catalog.jsonb_array_elements(path_item) as step(value)
      loop
        ends := relationships -> pg_catalog.lower(step_item #>> '{}');
        if ends is not null then
          pending := pending || (ends ->> 'from') || array(
            select target.value from pg_catalog.jsonb_array_elements_text(ends -> 'to') as target(value));
        end if;
      end loop;
    end loop;
  end loop;

  -- Then, transitively: the source types of every total, and every relationship the builder's
  -- access follows to decide a record type's records (its owner and each relationship route).
  while pg_catalog.cardinality(pending) > 0 loop
    current_id := pending[1];
    pending := pending[2:];
    continue when current_id is null or current_id = any (closure)
      or not current_id = any (storage_ids);
    closure := closure || current_id;
    record_type_item := definitions -> current_id;
    for field_item in
      select field.value
      from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb))
        as field(value)
      where field.value ->> 'type' = 'total'
    loop
      pending := pending || (relationships
        -> pg_catalog.lower(field_item #>> '{settings,relationshipId}') ->> 'from');
    end loop;
    for ends in
      select relationships -> pg_catalog.lower(owner.value)
      from (values (record_type_item ->> 'ownershipRelationshipId'),
        (live_plan -> 'recordTypes' -> current_id ->> 'ownershipRelationshipId')) as owner(value)
      where owner.value is not null
      union all
      select relationships -> pg_catalog.lower(route.value ->> 'relationshipId')
      from pg_catalog.jsonb_each(coalesce(live_plan -> 'permissions', '{}'::jsonb))
        as permission(key, value)
      cross join lateral pg_catalog.jsonb_array_elements(
        coalesce(permission.value #> '{recordScope,routes}', '[]'::jsonb)
      ) as route(value)
      where pg_catalog.lower(permission.value ->> 'recordTypeId') = current_id
        and route.value ->> 'kind' = 'relationship'
    loop
      continue when ends is null;
      pending := pending || (ends ->> 'from') || array(
        select target.value from pg_catalog.jsonb_array_elements_text(ends -> 'to') as target(value));
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'closure', pg_catalog.to_jsonb(closure),
    'derivedRecordTypeIds', pg_catalog.to_jsonb(derived_ids),
    'totalsOver', totals_over
  );
end
$function$;

alter function vortex_definition.preview_demand_closure_internal(uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.preview_demand_closure_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.preview_demand_closure_internal(uuid, jsonb)
  to vortex_owner;
comment on function vortex_definition.preview_demand_closure_internal(uuid, jsonb) is
  'The record types one demand on a preview needs, decided from the preview''s own releases and its builder''s live access plan, never from the caller: each demanded type, the targets of its demanded relationship fields and query relationship paths, and transitively every total''s source type and every relationship the builder''s access follows to decide a type''s records. Also lists the preview''s record types with derived fields and, by record type, the types that total over it. Runs in the installed Application''s own context.';
