create or replace function vortex_access.metering_event_dimensions_are_valid(p_dimensions jsonb)
returns boolean
language sql
stable
strict
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_dimensions) = 'object'
    and pg_catalog.pg_column_size(p_dimensions) <= 4096
    and (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_dimensions)
    ) <= 16
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_dimensions) as entry(key, value)
      where pg_catalog.length(entry.key) > 40
        or entry.key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
        or pg_catalog.string_to_array(entry.key, '_')
          && vortex_access.validation_reference_list('metering_forbidden_dimension_word')
        or not (
          (pg_catalog.jsonb_typeof(entry.value) = 'string'
            and pg_catalog.length(entry.value #>> '{}') between 1 and 120
            and (entry.value #>> '{}') ~ '^[a-z0-9](?:[a-z0-9_.:-]*[a-z0-9])?$')
          or pg_catalog.jsonb_typeof(entry.value) = 'boolean'
          or (pg_catalog.jsonb_typeof(entry.value) = 'number'
            and (entry.value #>> '{}') ~ '^-?[0-9]+$'
            and (entry.value #>> '{}')::numeric
              between -9007199254740991 and 9007199254740991)
        )
    );
$function$;

revoke all on function vortex_access.metering_event_dimensions_are_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.metering_event_dimensions_are_valid(jsonb) is
  'Storage check for safe metering dimensions: a small flat map of bounded scalars whose keys name no word in the metering_forbidden_dimension_word reference list.';
