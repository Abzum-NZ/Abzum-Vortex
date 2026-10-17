create or replace function vortex_record.record_type_listing_query_internal(
  p_module_root_id uuid,
  p_record_type jsonb
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  -- Every record type can be listed by its own identity: the query a record picker reads. It
  -- selects only the title, sorts by it and declares no inputs, filter, groups or totals, so the
  -- engine's own access, field read policy, search and keyset paging decide everything it returns.
  select case
    when pg_catalog.jsonb_typeof(p_record_type) = 'object'
      and coalesce(pg_catalog.pg_input_is_valid(p_record_type ->> 'recordTypeId', 'uuid'), false)
      and coalesce(pg_catalog.pg_input_is_valid(p_record_type ->> 'titleFieldId', 'uuid'), false)
      and p_module_root_id is not null
    then pg_catalog.jsonb_build_object(
      'queryId', p_record_type ->> 'recordTypeId',
      'key', 'records',
      'recordType', pg_catalog.jsonb_build_object(
        'state', 'resolved',
        'moduleRootId', p_module_root_id,
        'recordTypeId', p_record_type ->> 'recordTypeId'
      ),
      'inputs', '[]'::jsonb,
      'selectedFieldIds', pg_catalog.jsonb_build_array(p_record_type ->> 'titleFieldId'),
      'filter', null,
      'groupByFieldIds', '[]'::jsonb,
      'aggregates', '[]'::jsonb,
      'sort', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', p_record_type ->> 'titleFieldId', 'direction', 'ascending'
      )),
      'pageSize', 200,
      'relationshipHops', 0
    )
  end
$function$;

alter function vortex_record.record_type_listing_query_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.record_type_listing_query_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.record_type_listing_query_internal(uuid,jsonb) is
  'Private: the query that lists one record type by its own identity (title only, sorted by title, no inputs or filter), which the module query resolvers return when no authored query has that identity.';
