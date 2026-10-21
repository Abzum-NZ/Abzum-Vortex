-- #3385: a named view's document states every part of its query state (sort, filters, search, formatting), empty or not; there is one shape and no part is absent.

set local role vortex_owner;

create or replace function vortex_platform.grid_view_document_valid_internal(
  p_document jsonb,
  p_kind text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_document is not null
    and pg_catalog.jsonb_typeof(p_document) = 'object'
    and pg_catalog.octet_length(p_document::text) <= 32768
    -- A current layout holds the arrangement only; a named view adds the query state.
    and not exists (
      select 1 from pg_catalog.jsonb_object_keys(p_document) as supplied(key)
      where supplied.key <> all (case p_kind
        when 'current_layout' then array['columns', 'density']
        else array['columns', 'density', 'sort', 'filters', 'search', 'formatting'] end)
    )
    -- A named view states every part of its query state, empty or not.
    and (p_kind = 'current_layout' or p_document ?& array['sort', 'filters', 'search', 'formatting'])
    and pg_catalog.jsonb_typeof(p_document -> 'columns') = 'array'
    and pg_catalog.jsonb_array_length(p_document -> 'columns') between 1 and 200
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'object'
        or entry.value - array['fieldId', 'visible', 'width', 'pin'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
        or pg_catalog.jsonb_typeof(entry.value -> 'visible') is distinct from 'boolean'
        or pg_catalog.jsonb_typeof(entry.value -> 'pin') is distinct from 'string'
        or entry.value ->> 'pin' not in ('start', 'end', 'unpinned')
        or (entry.value ? 'width' and case
          when pg_catalog.jsonb_typeof(entry.value -> 'width') = 'number' then
            (entry.value ->> 'width')::numeric not between 64 and 640
            or (entry.value ->> 'width')::numeric <> pg_catalog.trunc((entry.value ->> 'width')::numeric)
          else true end)
    )
    and exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
      where entry.value -> 'visible' = 'true'::jsonb
    )
    and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
      from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value))
      = pg_catalog.jsonb_array_length(p_document -> 'columns')
    and (not p_document ? 'density' or (
      pg_catalog.jsonb_typeof(p_document -> 'density') = 'string'
      and p_document ->> 'density' in ('compact', 'comfortable')))
    and (p_kind = 'current_layout' or (
      pg_catalog.jsonb_typeof(p_document -> 'sort') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'sort') between 0 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'direction'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or coalesce(entry.value ->> 'direction' <> all (array['ascending', 'descending']), true)
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'sort')))
    and (p_kind = 'current_layout' or (
      pg_catalog.jsonb_typeof(p_document -> 'filters') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'filters') between 0 and 50
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'filter'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or pg_catalog.jsonb_typeof(entry.value -> 'filter') is distinct from 'string'
          or pg_catalog.char_length(entry.value ->> 'filter') not between 1 and 4000
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'filters')))
    and (p_kind = 'current_layout' or (
      pg_catalog.jsonb_typeof(p_document -> 'search') = 'null'
      or (pg_catalog.jsonb_typeof(p_document -> 'search') = 'string'
        and pg_catalog.char_length(p_document ->> 'search') between 1 and 200)))
    -- Personal formatting rules have the authored conditional-format rule shape.
    and (p_kind = 'current_layout' or (
      pg_catalog.jsonb_typeof(p_document -> 'formatting') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'formatting') between 0 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'formatting') as entry(value)
        where not vortex_platform.grid_view_format_rule_valid_internal(entry.value)
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'id'))
        from pg_catalog.jsonb_array_elements(p_document -> 'formatting') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'formatting'))), false)
$function$;

revoke all on function vortex_platform.grid_view_document_valid_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_document_valid_internal(jsonb, text) is
  'Whether a grid view document holds only the arrangement and, for a named view, the query state and personal formatting rules the platform stores; owner-only.';

alter function vortex_platform.grid_view_document_valid_internal(jsonb, text) owner to vortex_owner;

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
  if pg_catalog.jsonb_array_length(p_document -> 'filters') = 0
    and pg_catalog.jsonb_array_length(p_document -> 'sort') = 0
    and pg_catalog.jsonb_array_length(p_document -> 'formatting') = 0 then
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
    document := document || pg_catalog.jsonb_build_object('filters', filters);
  end if;
  if p_document ? 'sort' then
    select coalesce(pg_catalog.jsonb_agg(sort.value order by sort.ordinal), '[]'::jsonb)
    into sorts
    from pg_catalog.jsonb_array_elements(p_document -> 'sort')
      with ordinality as sort(value, ordinal)
    where pg_catalog.lower(sort.value ->> 'fieldId') = any(readable);
    omitted_sorts := pg_catalog.jsonb_array_length(p_document -> 'sort') - pg_catalog.jsonb_array_length(sorts);
    document := document || pg_catalog.jsonb_build_object('sort', sorts);
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
    document := document || pg_catalog.jsonb_build_object('formatting', formatting);
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

create or replace function vortex_platform.save_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_query_id uuid,
  p_view_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_document jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_platform.grid_views%rowtype;
  held_found boolean;
  owned_count bigint;
  installation jsonb;
  access_plan jsonb;
  record_type_id uuid;
  field_types jsonb;
  field_nulls jsonb;
  format_rule jsonb;
  written_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_query_id is null or not vortex_platform.is_non_nil_uuid(p_query_id::text)
    or (p_view_id is null) <> (p_expected_revision is null)
    or (p_view_id is not null and not vortex_platform.is_non_nil_uuid(p_view_id::text))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    -- A new view needs a name and a document; a change may leave either as it is.
    or (p_view_id is null and (p_name is null or p_document is null))
    or (p_name is not null and (p_name <> pg_catalog.btrim(p_name)
      or pg_catalog.char_length(p_name) not between 1 and 80))
    or (p_document is not null
      and not vortex_platform.grid_view_document_valid_internal(p_document, 'named_view')) then
    raise exception using errcode = '22023', message = 'Grid view save is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- A personal rule reads fields that exist and that the author can read now; the projection that
  -- recipients receive is the check, so a rule it would omit for the author is refused here.
  if p_document is not null and pg_catalog.jsonb_array_length(p_document -> 'formatting') > 0 then
    installation := vortex_definition.read_current_active_installation();
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid into record_type_id
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}') as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id;
    -- Record-type listings use their record type as the query identity.
    if record_type_id is null and access_plan -> 'recordTypes' ? p_query_id::text then
      record_type_id := p_query_id;
    end if;
    if (vortex_platform.grid_view_document_for_viewer_internal(
        p_query_id, p_document, installation, access_plan,
        case when record_type_id is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
          pg_catalog.lower(record_type_id::text),
          vortex_record.resolve_record_type_visible_field_ids_internal(record_type_id, access_plan)
        ) end) ->> 'hiddenFormatting')::integer > 0 then
      return pg_catalog.jsonb_build_object('outcome', 'formatting_refused', 'cause', 'field_not_readable');
    end if;
    -- A field the mapping does not know stays out, so a rule naming it is refused as rule_invalid.
    select pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', kind.value),
      pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', 'null'::jsonb)
    into field_types, field_nulls
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    cross join lateral (select vortex_access.condition_field_type_internal(field.value)) as kind(value)
    where (record_type.value ->> 'recordTypeId')::uuid = record_type_id
      and kind.value is not null;
    for format_rule in select value from pg_catalog.jsonb_array_elements(p_document -> 'formatting')
    loop
      begin
        perform vortex_access.evaluate_query_condition_internal(
          format_rule -> 'condition', field_types, field_nulls,
          '{"today":"date","start_of_week":"date","end_of_week":"date","start_of_month":"date","end_of_month":"date"}'::jsonb,
          '{"today":null,"start_of_week":null,"end_of_week":null,"start_of_month":null,"end_of_month":null}'::jsonb,
          true);
      exception when invalid_parameter_value then
        return pg_catalog.jsonb_build_object('outcome', 'formatting_refused', 'cause', 'rule_invalid');
      end;
    end loop;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.application_root_id::text || ':' ||
    p_page_id::text || ':' || p_placement_id::text || ':views',
    0
  ));

  if p_view_id is null then
    select pg_catalog.count(*) into owned_count
    from vortex_platform.grid_views as owned
    where owned.organization_id = scope.organization_id
      and owned.organization_account_id = scope.organization_account_id
      and owned.application_root_id = scope.application_root_id
      and owned.page_id = p_page_id
      and owned.placement_id = p_placement_id
      and owned.kind = 'named_view';
    if owned_count >= 50 then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into vortex_platform.grid_views (
      view_id, tenant_id, organization_id, organization_account_id, application_root_id,
      page_id, placement_id, kind, query_id, revision, release_revision, name, scope,
      document, created_at, updated_at
    ) values (
      pg_catalog.gen_random_uuid(), scope.tenant_id, scope.organization_id,
      scope.organization_account_id, scope.application_root_id, p_page_id, p_placement_id,
      'named_view', p_query_id,
      pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
      scope.release_revision, p_name, 'personal', p_document, written_at, written_at
    )
    returning * into stored;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
  end if;

  -- Only a view the person owns or that is shared with them can be named at all.
  if not vortex_platform.grid_view_visible_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id,
    p_page_id, p_placement_id, p_view_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.view_id = p_view_id
    and held.organization_id = scope.organization_id
  for update;
  held_found := found;
  if not held_found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  -- Only the owner, or someone who may share table views, changes a view.
  if stored.organization_account_id <> scope.organization_account_id
    and not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'revision', stored.revision,
      'name', stored.name,
      'queryId', stored.query_id
    );
  end if;

  update vortex_platform.grid_views as held
  set query_id = case when p_document is null then held.query_id else p_query_id end,
    name = coalesce(p_name, held.name),
    document = coalesce(p_document, held.document),
    revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
    release_revision = scope.release_revision,
    updated_at = written_at
  where held.view_id = stored.view_id
  returning held.* into stored;

  return pg_catalog.jsonb_build_object(
    'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  to vortex_request;

comment on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb) is
  'Creates a named grid view of the current person, or renames or replaces one at the expected revision (the owner, or someone who may share table views), or returns the stored revision as a conflict.';

alter function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  owner to vortex_owner;

reset role;
