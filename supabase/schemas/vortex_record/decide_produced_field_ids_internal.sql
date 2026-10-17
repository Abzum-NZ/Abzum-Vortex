create or replace function vortex_record.decide_produced_field_ids_internal(
  p_plan jsonb,
  p_record_type_id uuid,
  p_readable_field_ids jsonb,
  p_seen_record_type_ids jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  type_key text;
  fields_value jsonb;
  record_types_value jsonb;
  relationships_value jsonb;
  field_value jsonb;
  field_id text;
  dependency_id text;
  readable_ids text[];
  allowed_ids text[];
  contract_value jsonb;
  source_type_key text;
  source_bounds jsonb;
  source_bounds_by_type jsonb := '{}'::jsonb;
  dependencies_allowed boolean;
  changed boolean := true;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_plan -> 'recordTypes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_seen_record_type_ids) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Produced field decision input is invalid';
  end if;
  type_key := pg_catalog.lower(p_record_type_id::text);
  fields_value := p_plan -> 'recordTypes' -> type_key -> 'fields';
  if pg_catalog.jsonb_typeof(fields_value) is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into readable_ids
  from pg_catalog.jsonb_array_elements(p_readable_field_ids) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';

  -- Without a readable calculation or total the field policy alone decides.
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(fields_value) as field(value)
    where field.value ->> 'type' in ('calculation', 'total')
      and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
  ) then
    return p_readable_field_ids;
  end if;

  -- Stored fields keep the visibility the field policy gave them.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value ->> 'fieldId')), array[]::text[])
  into allowed_ids
  from pg_catalog.jsonb_array_elements(fields_value) as field(value)
  where field.value ->> 'type' not in ('calculation', 'total')
    and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids);

  -- A total is readable only when the reader can read every record it adds
  -- up and every field it uses there: an unconditioned all-records read of
  -- the child record type that guarantees the summed field and every filter
  -- field, each decided by this same rule. Any narrowing record scope, a
  -- refused or undeclared read, an unknown relationship or a cycle back to a
  -- record type still being decided leaves it Restricted.
  for field_value in
    select field.value
    from pg_catalog.jsonb_array_elements(fields_value) as field(value)
    where field.value ->> 'type' = 'total'
      and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
  loop
    field_id := pg_catalog.lower(field_value ->> 'fieldId');
    if record_types_value is null then
      select coalesce(pg_catalog.jsonb_agg(meta.value order by meta.key collate "C"), '[]'::jsonb)
      into record_types_value
      from pg_catalog.jsonb_each(p_plan -> 'recordTypes') as meta(key, value);
      select coalesce(pg_catalog.jsonb_agg(declared.value order by declared.key collate "C"), '[]'::jsonb)
      into relationships_value
      from pg_catalog.jsonb_each(coalesce(p_plan -> 'relationships', '{}'::jsonb)) as declared(key, value);
    end if;
    contract_value := vortex_record.total_dependency_contract_internal(
      record_types_value, relationships_value, p_record_type_id, field_value
    );
    if contract_value is null then
      continue;
    end if;
    source_type_key := pg_catalog.lower(contract_value ->> 'sourceRecordTypeId');
    if p_seen_record_type_ids ? source_type_key then
      continue;
    end if;
    source_bounds := source_bounds_by_type -> source_type_key;
    if source_bounds is null then
      source_bounds := vortex_record.decide_record_type_read_bounds_internal(
        p_plan, (contract_value ->> 'sourceRecordTypeId')::uuid,
        p_seen_record_type_ids || pg_catalog.jsonb_build_array(type_key)
      );
      source_bounds_by_type := source_bounds_by_type
        || pg_catalog.jsonb_build_object(source_type_key, source_bounds);
    end if;
    if (source_bounds -> 'coversAllRecords') = 'true'::jsonb
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(contract_value -> 'sourceFieldIds') as required(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(source_bounds -> 'readableFieldIds') as guaranteed(value)
          where pg_catalog.lower(guaranteed.value) = pg_catalog.lower(required.value)
        )
      ) then
      allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
    end if;
  end loop;

  -- A calculation is readable only when every field it depends on is: its
  -- declared dependencies, through other calculations and totals, to a fixed
  -- point over what is already allowed.
  while changed loop
    changed := false;
    for field_value in
      select field.value
      from pg_catalog.jsonb_array_elements(fields_value) as field(value)
      where field.value ->> 'type' = 'calculation'
        and pg_catalog.lower(field.value ->> 'fieldId') = any (readable_ids)
        and pg_catalog.lower(field.value ->> 'fieldId') <> all (allowed_ids)
    loop
      field_id := pg_catalog.lower(field_value ->> 'fieldId');
      if pg_catalog.jsonb_typeof(field_value -> 'settings' -> 'dependencyFieldIds') is distinct from 'array' then
        continue;
      end if;
      dependencies_allowed := true;
      for dependency_id in
        select pg_catalog.lower(item.value #>> '{}')
        from pg_catalog.jsonb_array_elements(field_value -> 'settings' -> 'dependencyFieldIds') as item(value)
      loop
        if dependency_id is null or dependency_id <> all (allowed_ids) then
          dependencies_allowed := false;
          exit;
        end if;
      end loop;
      if dependencies_allowed then
        allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
        changed := true;
      end if;
    end loop;
  end loop;

  return coalesce((
    select pg_catalog.jsonb_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements(p_readable_field_ids)
      with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and pg_catalog.lower(item.value #>> '{}') = any (allowed_ids)
  ), '[]'::jsonb);
end
$function$;

alter function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_produced_field_ids_internal(jsonb, uuid, jsonb, jsonb) is
  'Private field-read decision for produced fields, applied to the fields a reader''s field policy allows on one record type of one installation access plan: a total stays readable only when an unconditioned all-records read of its child record type guarantees the reader its summed and filter fields, and a calculation only when every dependency is readable, transitively; anything else is withheld and shown as Restricted. Fails closed on an unknown relationship, a refused child read and a cycle of totals.';
