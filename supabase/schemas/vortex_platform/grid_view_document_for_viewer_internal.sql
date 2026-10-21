create or replace function vortex_platform.grid_view_document_for_viewer_internal(
  p_query_id uuid, p_document jsonb, p_installation jsonb, p_plan jsonb, p_visible_fields jsonb
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
  sorts jsonb;
  formatting jsonb;
  omitted integer := 0;
  omitted_sorts integer := 0;
  omitted_formatting integer := 0;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters') and not (p_document ? 'sort') and not (p_document ? 'formatting') then
    return pg_catalog.jsonb_build_object(
      'document', document, 'hiddenFilters', 0, 'hiddenSorts', 0, 'hiddenFormatting', 0);
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
      -- A saved operand stays only on a field every record the reader reaches exposes (the query
      -- engine's field bounds, including direct-share restrictions) and the reader's column
      -- decision (the visible fields) offers.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value)
      where coalesce(p_visible_fields -> pg_catalog.lower(record_type_id::text), '[]'::jsonb)
        ? pg_catalog.lower(field.value);
    end if;
  end if;
  if p_document ? 'filters' then
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
  end if;
  if p_document ? 'sort' then
    select coalesce(pg_catalog.jsonb_agg(sort.value order by sort.ordinal), '[]'::jsonb)
    into sorts
    from pg_catalog.jsonb_array_elements(p_document -> 'sort')
      with ordinality as sort(value, ordinal)
    where pg_catalog.lower(sort.value ->> 'fieldId') = any(readable);
    omitted_sorts := pg_catalog.jsonb_array_length(p_document -> 'sort') - pg_catalog.jsonb_array_length(sorts);
    document := document - 'sort';
    if pg_catalog.jsonb_array_length(sorts) > 0 then
      document := document || pg_catalog.jsonb_build_object('sort', sorts);
    end if;
  end if;
  if p_document ? 'formatting' then
    -- A rule leaves with everything it stores (its comparison values and targets) unless every
    -- field it reads, in its condition or its cells, is one this viewer can read now.
    select coalesce(pg_catalog.jsonb_agg(rule.value order by rule.ordinal), '[]'::jsonb)
    into formatting
    from pg_catalog.jsonb_array_elements(p_document -> 'formatting')
      with ordinality as rule(value, ordinal)
    where vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1) is not null
      and not exists (
        select 1
        from pg_catalog.unnest(
          vortex_platform.grid_view_condition_field_ids_internal(rule.value -> 'condition', 1)
          || array(select pg_catalog.lower(cell.value)
            from pg_catalog.jsonb_array_elements_text(rule.value -> 'target' -> 'fields') as cell(value))
        ) as used(field_id)
        where used.field_id <> all (readable)
      );
    omitted_formatting := pg_catalog.jsonb_array_length(p_document -> 'formatting')
      - pg_catalog.jsonb_array_length(formatting);
    document := document - 'formatting';
    if pg_catalog.jsonb_array_length(formatting) > 0 then
      document := document || pg_catalog.jsonb_build_object('formatting', formatting);
    end if;
  end if;
  if omitted > 0 or omitted_sorts > 0 or omitted_formatting > 0 then
    raise log 'Grid view state omitted code=GRID_VIEW_FIELDS_WITHHELD filters=% sorts=% formatting=%',
      omitted, omitted_sorts, omitted_formatting;
  end if;
  return pg_catalog.jsonb_build_object(
    'document', document, 'hiddenFilters', omitted, 'hiddenSorts', omitted_sorts,
    'hiddenFormatting', omitted_formatting);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Removes saved filter values, sorts and formatting rules outside the reader''s current column decision and field bounds before a selected document leaves the database; owner-only, with counts for the omission notice.';
