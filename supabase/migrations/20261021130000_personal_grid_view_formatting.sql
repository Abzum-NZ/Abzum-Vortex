-- #3207: personal formatting in saved views, validated and projected under current access.

set local role vortex_owner;

create or replace function vortex_platform.grid_view_condition_field_ids_internal(
  p_condition jsonb,
  p_depth integer
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  node_kind text;
  collected text[] := '{}'::text[];
  child text[];
  child_node jsonb;
  operand jsonb;
  operator_name text;
begin
  if p_depth > 10 or p_condition is null or pg_catalog.jsonb_typeof(p_condition) <> 'object' then
    return null;
  end if;
  node_kind := p_condition ->> 'kind';
  if node_kind in ('all', 'any') then
    if p_condition - array['kind', 'conditions'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_condition -> 'conditions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_condition -> 'conditions') not between 1 and 50 then
      return null;
    end if;
    for child_node in
      select entry.value from pg_catalog.jsonb_array_elements(p_condition -> 'conditions') as entry(value)
    loop
      child := vortex_platform.grid_view_condition_field_ids_internal(child_node, p_depth + 1);
      if child is null then
        return null;
      end if;
      collected := collected || child;
    end loop;
    return collected;
  end if;
  if node_kind = 'not' then
    if p_condition - array['kind', 'condition'] <> '{}'::jsonb then
      return null;
    end if;
    return vortex_platform.grid_view_condition_field_ids_internal(p_condition -> 'condition', p_depth + 1);
  end if;
  if node_kind is distinct from 'comparison'
    or p_condition - array['kind', 'operator', 'left', 'right'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_condition -> 'operator') is distinct from 'string' then
    return null;
  end if;
  operator_name := p_condition ->> 'operator';
  if operator_name <> all (array[
    'equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'greater_than',
    'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'is_empty', 'is_not_empty'
  ]) then
    return null;
  end if;
  -- An empty-value comparison has one operand; every other comparison has two.
  if (operator_name in ('is_empty', 'is_not_empty')) = (p_condition ? 'right')
    or not p_condition ? 'left' then
    return null;
  end if;
  for operand in
    select entry.value
    from pg_catalog.jsonb_array_elements(case when p_condition ? 'right'
      then pg_catalog.jsonb_build_array(p_condition -> 'left', p_condition -> 'right')
      else pg_catalog.jsonb_build_array(p_condition -> 'left') end) as entry(value)
  loop
    if pg_catalog.jsonb_typeof(operand) <> 'object' then
      return null;
    end if;
    case operand ->> 'source'
      when 'field' then
        if operand - array['source', 'fieldId'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(operand -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(operand ->> 'fieldId') then
          return null;
        end if;
        collected := collected || pg_catalog.lower(operand ->> 'fieldId');
      when 'value' then
        if operand - array['source', 'value'] <> '{}'::jsonb or not operand ? 'value' then
          return null;
        end if;
      when 'parameter' then
        if operand - array['source', 'key'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(operand -> 'key') is distinct from 'string'
          or operand ->> 'key' <> all (array[
            'today', 'start_of_week', 'end_of_week', 'start_of_month', 'end_of_month'
          ]) then
          return null;
        end if;
      else
        return null;
    end case;
  end loop;
  return collected;
end
$function$;

revoke all on function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer) is
  'The lower-cased field identities a canonical condition tree reads, or null when the tree is malformed; owner-only.';

alter function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer) owner to vortex_owner;

create or replace function vortex_platform.grid_view_format_rule_valid_internal(p_rule jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(p_rule) = 'object'
    and p_rule - array['id', 'enabled', 'condition', 'target', 'style', 'stopIfTrue'] = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_rule -> 'id') = 'string'
    and vortex_platform.is_non_nil_uuid(p_rule ->> 'id')
    and pg_catalog.jsonb_typeof(p_rule -> 'enabled') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'stopIfTrue') = 'boolean'
    and vortex_platform.grid_view_condition_field_ids_internal(p_rule -> 'condition', 1) is not null
    and pg_catalog.jsonb_typeof(p_rule -> 'target') = 'object'
    and (p_rule -> 'target' = '{"kind": "row"}'::jsonb or (
      (p_rule -> 'target') - array['kind', 'fields'] = '{}'::jsonb
      and p_rule -> 'target' ->> 'kind' = 'cells'
      and pg_catalog.jsonb_typeof(p_rule -> 'target' -> 'fields') = 'array'
      and pg_catalog.jsonb_array_length(p_rule -> 'target' -> 'fields') between 1 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_rule -> 'target' -> 'fields') as field(value)
        where pg_catalog.jsonb_typeof(field.value) is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(field.value #>> '{}')
      )))
    and pg_catalog.jsonb_typeof(p_rule -> 'style') = 'object'
    and (p_rule -> 'style') - array['token', 'tint', 'text', 'bold', 'strike', 'icon', 'badgeLabel'] = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'token') = 'string'
    and p_rule -> 'style' ->> 'token' = any (array['success', 'warning', 'info', 'destructive', 'muted'])
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'tint') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'text') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'bold') = 'boolean'
    and pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'strike') = 'boolean'
    and (not (p_rule -> 'style') ? 'icon' or (
      pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'icon') = 'string'
      and p_rule -> 'style' ->> 'icon' = any (array[
        'alert', 'check', 'info', 'clock', 'flag', 'star', 'x', 'arrow_up', 'arrow_down'
      ])))
    and (not (p_rule -> 'style') ? 'badgeLabel' or (
      pg_catalog.jsonb_typeof(p_rule -> 'style' -> 'badgeLabel') = 'string'
      and pg_catalog.char_length(p_rule -> 'style' ->> 'badgeLabel') between 1 and 40)),
    false)
$function$;

revoke all on function vortex_platform.grid_view_format_rule_valid_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_format_rule_valid_internal(jsonb) is
  'Whether one personal formatting rule of a grid view document has the authored conditional-format rule shape; owner-only.';

alter function vortex_platform.grid_view_format_rule_valid_internal(jsonb) owner to vortex_owner;

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
    and (not p_document ? 'sort' or (
      pg_catalog.jsonb_typeof(p_document -> 'sort') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'sort') between 1 and 20
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
    and (not p_document ? 'filters' or (
      pg_catalog.jsonb_typeof(p_document -> 'filters') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'filters') between 1 and 50
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
    and (not p_document ? 'search' or (
      pg_catalog.jsonb_typeof(p_document -> 'search') = 'string'
      and pg_catalog.char_length(p_document ->> 'search') between 1 and 200))
    -- Personal formatting rules have the authored conditional-format rule shape.
    and (not p_document ? 'formatting' or (
      pg_catalog.jsonb_typeof(p_document -> 'formatting') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'formatting') between 1 and 20
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
  formatting jsonb;
  omitted integer := 0;
  omitted_formatting integer := 0;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters') and not (p_document ? 'formatting') then
    return pg_catalog.jsonb_build_object(
      'document', document, 'hiddenFilters', 0, 'hiddenFormatting', 0);
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
  return pg_catalog.jsonb_build_object(
    'document', document, 'hiddenFilters', omitted, 'hiddenFormatting', omitted_formatting);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb) is
  'Removes saved filter values and formatting rules outside the current reader permission field policy before a selected document leaves the database; owner-only, with counts for the omission notice.';

create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[],
  p_selected_view_ids uuid[],
  p_default_views jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  targets record;
  shareable uuid[] := '{}'::uuid[];
  installation jsonb;
  access_plan jsonb;
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null
    or p_selected_view_ids is null
    or pg_catalog.cardinality(p_selected_view_ids) > 500
    or pg_catalog.array_position(p_selected_view_ids, null) is not null
    or p_default_views is null
    or pg_catalog.jsonb_typeof(p_default_views) is distinct from 'array'
 then
    raise exception using errcode = '22023', message = 'Grid view read is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_default_views) > 10000 or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    where pg_catalog.jsonb_typeof(supplied.value) is distinct from 'object'
      or supplied.value - array['viewId', 'queryId', 'document'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(supplied.value -> 'viewId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(supplied.value -> 'queryId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'viewId')
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'queryId')
      or not vortex_platform.grid_view_document_valid_internal(supplied.value -> 'document', 'named_view')
  ) then
    raise exception using errcode = '22023', message = 'Grid default view read is invalid';
  end if;
  if (select pg_catalog.count(distinct pg_catalog.lower(supplied.value ->> 'viewId'))
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value))
    <> pg_catalog.jsonb_array_length(p_default_views) then
    raise exception using errcode = '22023', message = 'Grid default view identities are duplicated';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;
  select viewer.* into strict targets from vortex_platform.grid_view_viewer_targets_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id
  ) as viewer;

  if vortex_platform.grid_view_may_share_internal() then
    shareable := p_placement_ids;
  end if;

  installation := vortex_definition.read_current_active_installation();
  if exists (select 1 from vortex_platform.grid_views as selected
    where selected.organization_id = scope.organization_id
      and selected.application_root_id = scope.application_root_id
      and selected.view_id = any(p_selected_view_ids)
      and (selected.document ? 'filters' or selected.document ? 'formatting'))
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
      where supplied.value -> 'document' ? 'filters' or supplied.value -> 'document' ? 'formatting') then
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
  end if;

  -- The person's current layouts and every named view they may see, for all the page's grids, in
  -- one bounded read. Only the views the address selected carry their document.
  return pg_catalog.jsonb_build_object(
    'defaultDocuments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('viewId', supplied.value ->> 'viewId')
        || vortex_platform.grid_view_document_for_viewer_internal(
          (supplied.value ->> 'queryId')::uuid, supplied.value -> 'document', installation, access_plan
        )
      )
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    ), '[]'::jsonb),
    'roleKeys', coalesce((
      select pg_catalog.jsonb_agg(distinct template.key)
      from vortex_access.organization_roles as role
      join vortex_access.application_role_template_continuities as template
        on template.organization_id = role.organization_id
        and template.application_root_id = coalesce(role.application_root_id, role.derived_application_root_id)
        and template.source_role_id = coalesce(role.source_role_id, role.derived_source_role_id)
        and template.state = 'available'
      where role.organization_id = scope.organization_id
        and template.application_root_id = scope.application_root_id
        and role.role_id = any(targets.role_ids)
    ), '[]'::jsonb),
    'shareablePlacementIds', pg_catalog.to_jsonb(shareable),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'placementId', stored.placement_id,
        'queryId', stored.query_id,
        'revision', stored.revision,
        'basedOnViewId', stored.based_on_view_id,
        'layout', stored.document
      ) order by stored.placement_id)
      from vortex_platform.grid_views as stored
      where stored.organization_id = scope.organization_id
        and stored.organization_account_id = scope.organization_account_id
        and stored.application_root_id = scope.application_root_id
        and stored.page_id = p_page_id
        and stored.placement_id = any (p_placement_ids)
        and stored.kind = 'current_layout'
    ), '[]'::jsonb),
    'views', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'viewId', listed.view_id,
        'placementId', listed.placement_id,
        'queryId', listed.query_id,
        'name', listed.name,
        'scope', listed.scope,
        'mine', listed.organization_account_id = scope.organization_account_id,
        'revision', listed.revision,
        'shareOrganization', listed.share_organization,
        'shareRoleIds', listed.share_role_ids,
        'shareGroupIds', listed.share_group_ids
      ) || case when listed.view_id = any (p_selected_view_ids)
        then vortex_platform.grid_view_document_for_viewer_internal(
          listed.query_id, listed.document, installation, access_plan
        ) else '{}'::jsonb end
        order by listed.placement_id, pg_catalog.lower(listed.name), listed.view_id)
      from (
        select visible.*, pg_catalog.row_number() over (
          partition by visible.placement_id
          order by pg_catalog.lower(visible.name), visible.view_id
        ) as position
        from vortex_platform.grid_views as visible
        where visible.organization_id = scope.organization_id
          and visible.application_root_id = scope.application_root_id
          and visible.page_id = p_page_id
          and visible.placement_id = any (p_placement_ids)
          and visible.kind = 'named_view'
          and (visible.organization_account_id = scope.organization_account_id
            or (visible.scope = 'shared'
              and (visible.share_organization
                or visible.share_role_ids && targets.role_ids
                or visible.share_group_ids && targets.group_ids)))
      ) as listed
      where listed.position <= 200
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) to vortex_request;

comment on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) is
  'Reads the current person''s current layouts and visible named views, and narrows authored default documents through the same current field bounds, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) owner to vortex_owner;

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
  if p_document is not null and p_document ? 'formatting' then
    installation := vortex_definition.read_current_active_installation();
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
    if (vortex_platform.grid_view_document_for_viewer_internal(
        p_query_id, p_document, installation, access_plan) ->> 'hiddenFormatting')::integer > 0 then
      return pg_catalog.jsonb_build_object('outcome', 'formatting_refused', 'cause', 'field_not_readable');
    end if;
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
    select pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', case
        when kind.value in ('whole_number', 'decimal_number', 'money', 'yes_no', 'date', 'date_time')
          then kind.value
        when kind.value = 'several_choices' then 'text_collection'
        when kind.value in ('link', 'link_to_one_of_several') then 'record_reference'
        when kind.value in ('table', 'attachment') then 'opaque_json'
        else 'text' end),
      pg_catalog.jsonb_object_agg(field.value ->> 'fieldId', 'null'::jsonb)
    into field_types, field_nulls
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,recordTypes}') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    cross join lateral (select case when field.value ->> 'type' in ('calculation', 'total')
      then field.value #>> '{settings,resultType}' else field.value ->> 'type' end) as kind(value)
    where (record_type.value ->> 'recordTypeId')::uuid = record_type_id;
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
