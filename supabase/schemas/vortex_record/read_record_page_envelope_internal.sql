create or replace function vortex_record.read_record_page_envelope_internal(
  p_record_type_id uuid,
  p_first_loaded jsonb
)
returns table (envelope jsonb, narrowed boolean, read_time jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  read_time_fields jsonb;
begin
  -- The record type's read-time fields and, when it has any, the statement's
  -- read-time clock: the same for every record of the page.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
  into read_time_fields
  from pg_catalog.jsonb_array_elements(p_first_loaded -> 'facts' -> 'recordTypes') as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and field.value ->> 'type' = 'calculation'
    and (field.value #>> '{settings,evaluation}' = 'read_time'
      or field.value #>> '{settings,expression,op}' = 'deadline_passed');
  read_time := pg_catalog.jsonb_build_object('readTimeFields', read_time_fields)
    || case when read_time_fields <> '{}'::jsonb
      then pg_catalog.jsonb_build_object('readTimeClock', vortex_record.read_time_clock_internal())
      else '{}'::jsonb end;
  -- The page-wide part of every record's read facts, built once for a page:
  -- the first record's facts, loaded by the exact loader in this invocation.
  -- Each record of the page differs only in its own stored record fact, its
  -- concurrency number and its definition revision.
  envelope := p_first_loaded;
  narrowed := false;
  -- When nothing about this record type can reach another record or another
  -- record type (no total field or saved condition, and every route of every
  -- permission on it is an all-record, owner or direct-share route), each record's facts carry
  -- only its own type and its own permissions, and no relationship: every
  -- reader of these facts (projection, derived fields, capabilities) looks at
  -- nothing else.
  if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}') as record_type(value)
      cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
      where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and field.value ->> 'type' = 'total'
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        -- A saved condition can bind the current person as a typed reference,
        -- which needs the directory type from these exact installation facts.
        and (declared.value #> '{recordScope,savedCondition}' is not null
          or pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}' else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in ('all_records', 'ownership', 'direct_share')
          ))
    ) then
    envelope := pg_catalog.jsonb_set(pg_catalog.jsonb_set(pg_catalog.jsonb_set(
      p_first_loaded, '{facts,relationships}', '[]'::jsonb), '{facts,recordTypes}', (
        select coalesce(pg_catalog.jsonb_agg(record_type.value order by record_type.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(p_first_loaded #> '{facts,recordTypes}')
          with ordinality as record_type(value, ordinality)
        where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      )), '{accessPermissions}', (
        select coalesce(pg_catalog.jsonb_object_agg(declared.key, declared.value), '{}'::jsonb)
        from pg_catalog.jsonb_each(p_first_loaded -> 'accessPermissions') as declared(key, value)
        where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      ));
    narrowed := true;
  end if;
  return next;
end
$function$;

alter function vortex_record.read_record_page_envelope_internal(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_page_envelope_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_page_envelope_internal(uuid,jsonb) is
  'Private page read helper for the fixed record adapter: the page-wide part of every record''s read facts, built once from the first record''s exact facts, narrowed to the record type and its permissions when nothing about that type reaches another record or type.';
