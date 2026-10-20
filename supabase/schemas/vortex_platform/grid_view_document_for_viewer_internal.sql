create or replace function vortex_platform.grid_view_document_for_viewer_internal(
  p_query_id uuid, p_document jsonb, p_installation jsonb, p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  declaration jsonb;
  eligibility jsonb;
  readable text[] := '{}'::text[];
  filters jsonb;
  omitted integer;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters') then
    return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', 0);
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Resolve only releases pinned by this validated installation, including record-type listings.
  select target.record_type_id into record_type_id
  from (
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid as record_type_id
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}'
    ) as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id
    union
    select p_query_id
    where p_plan -> 'recordTypes' ? pg_catalog.lower(p_query_id::text)
  ) as target;
  if record_type_id is not null then
    declaration := vortex_record.record_type_read_declaration_internal(
      p_plan, record_type_id, (context_value ->> 'applicationRootId')::uuid
    );
    if declaration is not null then
      -- Reuse the query engine's current field bounds, including direct-share restrictions.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value);
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(filter.value order by filter.ordinal), '[]'::jsonb)
  into filters
  from pg_catalog.jsonb_array_elements(p_document -> 'filters')
    with ordinality as filter(value, ordinal)
  where pg_catalog.lower(filter.value ->> 'fieldId') = any(readable);
  omitted := pg_catalog.jsonb_array_length(p_document -> 'filters') - pg_catalog.jsonb_array_length(filters);
  document := document - 'filters';
  if pg_catalog.jsonb_array_length(filters) > 0 then
    document := document || pg_catalog.jsonb_build_object('filters', filters);
  end if;
  return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', omitted);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb) is
  'Removes saved filter values outside the current reader permission field policy before a selected document leaves the database; owner-only, with a count for the omission notice.';
