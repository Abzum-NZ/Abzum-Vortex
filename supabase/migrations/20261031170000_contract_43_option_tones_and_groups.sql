set role vortex_owner;

create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['4.3.0'];
    when 'module' then
      return array['4.3.0'];
    when 'record_type' then
      return array['4.3.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

revoke all on function vortex_definition.accepted_contract_version(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_definition.accepted_contract_version(text) is
  'The one accepted definition contract version per contract kind (a one-element array); the single SQL source of truth, compared with the TypeScript definitionContractVersion constant by the guard. application: vortex_definition.provision_module_installation_storage and vortex_definition.activate_application_installation (detach checks release identity only). module: vortex_record.provision_exact_module_storage. record_type: vortex_access.evaluate_organization_record_access_internal.';

alter function vortex_definition.accepted_contract_version(p_kind text) owner to vortex_owner;

grant execute on function vortex_definition.accepted_contract_version(p_kind text) to postgres;

-- Contract 4.3.0: a choice option carries the colour role a pipeline stage used to carry, and the
-- person part a query binding reads is the person's group. Every stored draft moves its pipeline
-- stage tones onto the stage field's options and renames the person part in place, once. Releases
-- published under 4.2.0 stay as history through the superseded-contract path.
create function pg_temp.contract_43_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result text;
  member text;
  first boolean := true;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{';
      for member in
        select item.key from pg_catalog.jsonb_object_keys(p_value) as item(key)
        order by item.key collate "C"
      loop
        result := result || case when first then '' else ',' end
          || pg_catalog.to_json(member)::text || ':'
          || pg_temp.contract_43_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(pg_temp.contract_43_canonical_json(item.value), ',' order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.contract_43_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_temp.contract_43_canonical_json(p_value), 'UTF8')),
    'hex'
  )
$function$;

-- One authored Module: each pipeline stage's colour role moves onto the option it names.
create function pg_temp.contract_43_module(p_module jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  records jsonb := '[]'::jsonb;
  record jsonb;
  fields jsonb;
  field jsonb;
  pipelines jsonb;
  pipeline jsonb;
  stages jsonb;
  stage jsonb;
  options jsonb;
  option jsonb;
  stage_field text;
  tone text;
begin
  if pg_catalog.jsonb_typeof(p_module -> 'record_types') is distinct from 'array' then
    return p_module;
  end if;
  for record in select item.value from pg_catalog.jsonb_array_elements(p_module -> 'record_types') as item(value) loop
    if pg_catalog.jsonb_typeof(record -> 'pipelines') is distinct from 'array'
      or pg_catalog.jsonb_array_length(record -> 'pipelines') = 0 then
      records := records || pg_catalog.jsonb_build_array(record);
      continue;
    end if;
    pipelines := '[]'::jsonb;
    for pipeline in select item.value from pg_catalog.jsonb_array_elements(record -> 'pipelines') as item(value) loop
      stage_field := pipeline ->> 'stage_field';
      fields := record -> 'fields';
      fields := coalesce((
        select pg_catalog.jsonb_agg(
          case when item.value ->> 'key' = stage_field then (
            select pg_catalog.jsonb_set(item.value, '{settings,options}', coalesce((
              select pg_catalog.jsonb_agg(
                case when not (option.value ? 'tone') and exists (
                    select 1 from pg_catalog.jsonb_array_elements(pipeline -> 'stages') as moved(value)
                    where moved.value ->> 'option' = option.value ->> 'value' and moved.value ? 'tone')
                  then pg_catalog.jsonb_set(option.value, '{tone}', pg_catalog.to_jsonb(((
                    select moved.value ->> 'tone'
                    from pg_catalog.jsonb_array_elements(pipeline -> 'stages') as moved(value)
                    where moved.value ->> 'option' = option.value ->> 'value' and moved.value ? 'tone'
                    limit 1))))
                  else option.value end
                order by option.ordinality)
              from pg_catalog.jsonb_array_elements(
                coalesce(item.value -> 'settings' -> 'options', '[]'::jsonb)
              ) with ordinality as option(value, ordinality)
            ), '[]'::jsonb))
          ) else item.value end
          order by item.ordinality)
        from pg_catalog.jsonb_array_elements(record -> 'fields') with ordinality as item(value, ordinality)
      ), '[]'::jsonb);
      stages := '[]'::jsonb;
      for stage in select item.value from pg_catalog.jsonb_array_elements(pipeline -> 'stages') as item(value) loop
        stages := stages || pg_catalog.jsonb_build_array(stage - 'tone');
      end loop;
      pipeline := pg_catalog.jsonb_set(pipeline, '{stages}', stages);
      pipelines := pipelines || pg_catalog.jsonb_build_array(pipeline);
    end loop;
    record := pg_catalog.jsonb_set(record, '{fields}', fields);
    record := pg_catalog.jsonb_set(record, '{pipelines}', pipelines);
    records := records || pg_catalog.jsonb_build_array(record);
  end loop;
  return pg_catalog.jsonb_set(p_module, '{record_types}', records);
end
$function$;

-- Every stored query binding that read the person's team now reads their group.
create function pg_temp.contract_43_groups(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb;
  member record;
  part jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{}'::jsonb;
      for member in select item.key, item.value from pg_catalog.jsonb_each(p_value) as item(key, value) loop
        part := member.value;
        if member.key = 'part'
          and pg_catalog.jsonb_typeof(part) = 'object'
          and part ->> 'kind' = 'choice'
          and part ->> 'value' = 'team' then
          part := pg_catalog.jsonb_set(part, '{value}', '"group"'::jsonb);
        else
          part := pg_temp.contract_43_groups(part);
        end if;
        result := result || pg_catalog.jsonb_build_object(member.key, part);
      end loop;
      return result;
    when 'array' then
      return coalesce((
        select pg_catalog.jsonb_agg(pg_temp.contract_43_groups(item.value) order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

-- Every stored Record detail placement that declared a flat `detail_fields` list now declares one
-- section card holding the same fields in the same order.
create function pg_temp.contract_43_detail_sections(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb;
  member record;
  converted jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{}'::jsonb;
      for member in select item.key, item.value from pg_catalog.jsonb_each(p_value) as item(key, value) loop
        if member.key = 'detail_fields'
          and pg_catalog.jsonb_typeof(member.value) = 'array'
          and not (p_value ? 'sections') then
          result := result || pg_catalog.jsonb_build_object('sections', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'key', 'details', 'title', 'Details',
              'fields', pg_temp.contract_43_detail_sections(member.value))));
        else
          result := result || pg_catalog.jsonb_build_object(
            member.key, pg_temp.contract_43_detail_sections(member.value));
        end if;
      end loop;
      return result;
    when 'array' then
      return coalesce((
        select pg_catalog.jsonb_agg(pg_temp.contract_43_detail_sections(item.value) order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

-- Every stored permission that named a direct-share route loses that route; a permission whose only
-- route was direct sharing granted nothing, so it goes with its role grants left to the next publish.
create function pg_temp.contract_43_direct_share(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb;
  member record;
  item jsonb;
  routes jsonb;
  kept jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{}'::jsonb;
      for member in select entry.key, entry.value from pg_catalog.jsonb_each(p_value) as entry(key, value) loop
        result := result || pg_catalog.jsonb_build_object(
          member.key, pg_temp.contract_43_direct_share(member.value));
      end loop;
      return result;
    when 'array' then
      result := '[]'::jsonb;
      for item in select element.value from pg_catalog.jsonb_array_elements(p_value) as element(value) loop
        routes := item -> 'record_scope' -> 'routes';
        if pg_catalog.jsonb_typeof(routes) = 'array' then
          kept := coalesce((
            select pg_catalog.jsonb_agg(route.value order by route.ordinality)
            from pg_catalog.jsonb_array_elements(routes) with ordinality as route(value, ordinality)
            where route.value ->> 'kind' <> 'direct_share'
          ), '[]'::jsonb);
          if pg_catalog.jsonb_array_length(kept) = 0 then continue; end if;
          item := pg_catalog.jsonb_set(item, '{record_scope,routes}', kept);
        end if;
        result := result || pg_catalog.jsonb_build_array(
          pg_temp.contract_43_direct_share(item));
      end loop;
      return result;
    else
      return p_value;
  end case;
end
$function$;

-- Every stored definition that declared the removed assignment kind no longer names it: the field
-- definition, every readable/select/filter list entry, the person and group form inputs, the grid
-- column and every flow input that read it.
create function pg_temp.contract_43_assignment_kind(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb;
  member record;
  item jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{}'::jsonb;
      for member in select entry.key, entry.value from pg_catalog.jsonb_each(p_value) as entry(key, value) loop
        if member.key = 'assignment_kind' then continue; end if;
        result := result || pg_catalog.jsonb_build_object(
          member.key, pg_temp.contract_43_assignment_kind(member.value));
      end loop;
      return result;
    when 'array' then
      result := '[]'::jsonb;
      for item in select element.value from pg_catalog.jsonb_array_elements(p_value) as element(value) loop
        if item = '"assignment_kind"'::jsonb
          or (item ->> 'key') = 'assignment_kind'
          or (item ->> 'field') like '%.assignment_kind'
          or (item -> 'props' ->> 'name') = 'assignment_kind' then
          continue;
        end if;
        result := result || pg_catalog.jsonb_build_array(
          pg_temp.contract_43_assignment_kind(item));
      end loop;
      return result;
    else
      return p_value;
  end case;
end
$function$;

-- Every stored definition that named the removed assignment policy, the eligible assignment kind or a
-- role activation no longer names them: the field, its readable/select/filter list entries, role
-- activation record type, query, page blocks, bindings, permission and event.
create function pg_temp.contract_43_assignment_policy(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb;
  member record;
  item jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      if p_value ->> 'protected_view' = 'role_activations'
        or (p_value ->> 'key' = 'role_activation' and p_value ? 'fields') then
        return 'null'::jsonb;
      end if;
      result := '{}'::jsonb;
      for member in select entry.key, entry.value from pg_catalog.jsonb_each(p_value) as entry(key, value) loop
        if member.key = 'assignment_policy' then continue; end if;
        result := result || pg_catalog.jsonb_build_object(
          member.key, pg_temp.contract_43_assignment_policy(member.value));
      end loop;
      return result;
    when 'array' then
      result := '[]'::jsonb;
      for item in select element.value from pg_catalog.jsonb_array_elements(p_value) as element(value) loop
        if item = '"assignment_policy"'::jsonb
          or item = '"eligible"'::jsonb
          or (pg_catalog.jsonb_typeof(item) = 'object' and (
            (item ->> 'key') = 'assignment_policy'
            or (item ->> 'key') = 'role_activation'
            or (item ->> 'key') = 'application.iam.directory.role_activation.read'
            or (item ->> 'key') = 'vortex.app.iam.deactivate_role_activation'
            or (item ->> 'field') like '%.assignment_policy'
            or (item ->> 'field') like 'vortex.system_directory:role_activation.%'
            or (item -> 'props' ->> 'name') = 'assignment_policy'
            or (item ->> 'value') = 'eligible'
            or (item ->> 'protected_view') = 'role_activations'
            or (item ->> 'record_type') = 'vortex.system_directory:role_activation'
            or (item ->> 'flow') = 'flow_deactivate_role_activation'
            or (item ->> 'control') = 'iam_role_activations_region'
            or (item ->> 'query') like '%:role_activations'
            or (item ->> 'id') in (
              'iam_role_activations_region',
              'binding_deactivate_role_activation',
              'event_deactivate_role_activation',
              'flow_deactivate_role_activation',
              'perm_app_iam_role_activation_read',
              'qry_role_activations',
              'rt_system_directory_role_activation'
            )
          )) then
          continue;
        end if;
        result := result || pg_catalog.jsonb_build_array(
          pg_temp.contract_43_assignment_policy(item));
      end loop;
      return result;
    else
      return p_value;
  end case;
end
$function$;

do $convert$
declare
  draft record;
  converted jsonb;
  body jsonb;
begin
  for draft in select d.root_id, r.key, d.draft_source, d.source_fingerprint
    from vortex_definition.drafts d join vortex_definition.roots r on r.root_id = d.root_id
  loop
    if pg_temp.contract_43_fingerprint(draft.draft_source) is distinct from draft.source_fingerprint then
      raise exception 'Contract 4.3.0 cannot verify stored fingerprint of draft % (%)', draft.key, draft.root_id;
    end if;
  end loop;
  for draft in select d.root_id, d.draft_source
    from vortex_definition.drafts d
    order by d.root_id
  loop
    body := draft.draft_source -> 'body';
    if pg_catalog.jsonb_typeof(body -> 'modules') = 'array' then
      body := pg_catalog.jsonb_set(body, '{modules}', (
        select coalesce(pg_catalog.jsonb_agg(pg_temp.contract_43_module(item.value) order by item.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(body -> 'modules') with ordinality as item(value, ordinality)));
    else
      body := pg_temp.contract_43_module(body);
    end if;
    converted := pg_temp.contract_43_assignment_policy(
      pg_temp.contract_43_assignment_kind(
        pg_temp.contract_43_direct_share(
          pg_temp.contract_43_detail_sections(
            pg_temp.contract_43_groups(
              pg_catalog.jsonb_set(
                pg_catalog.jsonb_set(draft.draft_source, '{body}', body),
                '{source_contract_version}', '"4.3.0"'::jsonb))))));
    update vortex_definition.drafts d set
      draft_source = converted,
      source_contract_version = '4.3.0',
      source_fingerprint = pg_temp.contract_43_fingerprint(converted),
      draft_revision = d.draft_revision + 1,
      updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
      restored_from_release_revision = null,
      restored_from_source_fingerprint = null,
      restored_by = null, restored_at = null, restore_correlation_id = null
    where d.root_id = draft.root_id;
  end loop;
end
$convert$;

drop function pg_temp.contract_43_module(jsonb);
drop function pg_temp.contract_43_groups(jsonb);
drop function pg_temp.contract_43_detail_sections(jsonb);
drop function pg_temp.contract_43_direct_share(jsonb);
drop function pg_temp.contract_43_assignment_kind(jsonb);
drop function pg_temp.contract_43_assignment_policy(jsonb);
drop function pg_temp.contract_43_fingerprint(jsonb);
drop function pg_temp.contract_43_canonical_json(jsonb);

reset role;

set role vortex_record_adapter;

create or replace function vortex_record.module_query_board_member_internal(
  p_bound jsonb,
  p_selector jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fields_by_id jsonb := p_bound -> 'fieldsById';
  query_item jsonb := p_bound -> 'query';
  board_choice_field_id text := p_selector ->> 'choiceFieldId';
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_choice_column text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
begin
  -- A board reads members of its query's sole grouping key: one filterable choice field of 1..12
  -- closed options that the query selects.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
    or not ((p_bound -> 'selectedFieldIds') ? board_choice_field_id)
    or not (fields_by_id ? board_choice_field_id)
    or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
    or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
  if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
    or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
    if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
      or board_option - array['value', 'label', 'tone', 'requiredPermissionId']::text[] <> '{}'::jsonb
      or not (board_option ? 'value') or not (board_option ? 'label')
      or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
      or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
      or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
      or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
      or (board_option ? 'requiredPermissionId' and (
        pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
      ))
      or (board_option ->> 'value') collate "C" = any (board_option_values) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_selector -> 'columns') as requested(value)
    where requested.value ->> 'kind' = 'option'
      and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- A column reads only its own cards. When the reader is guaranteed to see the
  -- choice field on every row the scan examines, the stored choice value is the
  -- readable value, so the column's membership narrows the candidate scan and the
  -- budget is spent on that column's members only. Otherwise the scan stays
  -- unnarrowed and membership is decided from each readable projection, so
  -- a withheld value never decides which rows are examined.
  if (p_bound -> 'readableFieldIds') ? board_choice_field_id then
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = (p_bound ->> 'storageContractId')::uuid
      and mapping.field_id = board_choice_field_id::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    if mapping_row.database_value_type = 'text' then
      board_choice_column := mapping_row.physical_column_token;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'kind', 'choice',
    'choiceFieldId', board_choice_field_id,
    'optionValues', pg_catalog.to_jsonb(board_option_values),
    'columns', p_selector -> 'columns',
    'choiceColumn', board_choice_column
  );
end
$function$;

alter function vortex_record.module_query_board_member_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_member_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_member_internal(jsonb,jsonb) is
  'Adapter-only board membership of a bound Module query page read: requires the query''s sole grouping key to be the selected, filterable choice field the board names with 1 to 12 closed options, every requested option column to be one of them, and returns the closed choice membership value with the stored choice column only when the reader is guaranteed to see the choice field on every scanned row.';

reset role;

set role vortex_owner;

-- One protected summary plan: field policy, filter pushdown, aggregate expressions and candidate scan.
create or replace function vortex_record.module_summary_plan_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[],
  p_prepared_plan jsonb,
  p_query jsonb,
  p_grouping_field_id uuid,
  p_field_counts boolean,
  p_pivot_row_field_id uuid,
  p_pivot_column_field_id uuid,
  p_pivot_measure_field_id uuid,
  p_buckets jsonb,
  p_group_limit integer,
  p_group_after text,
  p_choice_field_id uuid,
  p_columns jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit constant integer := 100000;
  group_page_default constant integer := 40;
  group_page_maximum constant integer := 200;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb := p_prepared_plan;
  user_search text := nullif(pg_catalog.btrim(p_search), '');
  search_field_ids text[] := array[]::text[];
  declared_searchable_ids jsonb := coalesce(pg_catalog.to_jsonb(p_searchable_field_ids), '[]'::jsonb);
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  v_storage_contract_id uuid;
  physical_table_token text;
  storage_scope text;
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  readable_field_ids text[] := array[]::text[];
  bound_field_ids text[] := array[]::text[];
  filter_condition jsonb;
  filter_types jsonb := '{}'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  filter_ids text[] := array[]::text[];
  filter_predicate text := 'true';
  filter_parameters jsonb := '[]'::jsonb;
  filter_expression_pairs text[] := array[]::text[];
  filter_values_sql text := '''{}''::jsonb';
  group_ids text[] := array[]::text[];
  aggregate_items jsonb := '[]'::jsonb;
  aggregate_item jsonb;
  aggregate_aliases text[] := array[]::text[];
  summary_field_ids text[] := array[]::text[];
  fast_field_ids text[] := array[]::text[];
  fields_by_id jsonb := '{}'::jsonb;
  field_item jsonb;
  field_key text;
  field_type text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  fast_path boolean := false;
  fast_path_fields_valid boolean := true;
  search_prefilter_sql text := 'true';
  scan_sql text;
  candidate_sql text;
  selected_sql text;
  expression_pairs text[] := array[]::text[];
  group_value_pairs text[] := array[]::text[];
  group_by_terms text[] := array[]::text[];
  group_presence_terms text[] := array[]::text[];
  group_values_sql text;
  group_value_sql text;
  group_page_limit integer;
  group_after text := p_group_after;
  pivot_mode boolean := false;
  group_cursor jsonb;
  pivot_row_field_id text;
  pivot_column_field_id text;
  pivot_measure_field_id text;
  pivot_buckets jsonb := '{}'::jsonb;
  group_bucket jsonb;
  pivot_column_limit constant integer := 50;
  group_presence_sql text;
  group_dimension_sql text;
  group_axis_ctes_sql text;
  group_axis_joins_sql text := '';
  group_axis_index integer := 0;
  group_field_type text;
  group_axis_normalized text;
  group_axis_rank text;
  group_axis_title text;
  group_first_rank_sql text;
  group_axis_normalized_pairs text[] := array[]::text[];
  group_axis_title_terms text[] := array[]::text[];
  aggregate_object_sql text := '';
  summary_totals_sql text;
  aggregate_result_sql text;
  aggregate_count_sql text;
  aggregate_sum_sql text;
  aggregate_average_sql text;
  aggregate_present_sql text;
  aggregate_value_sql text;
  aggregate_currency_sql text;
  aggregate_amount_sql text;
  aggregate_mixed_currency_sql text;
  aggregate_operation text;
  aggregate_field_id text;
  aggregate_field_type text;
  aggregate_original_field_type text;
  aggregate_alias text;
  average_places integer;
  value_expression text;
  board_summary_mode boolean := false;
  board_choice_field_id text;
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_requested_columns jsonb := p_columns;
  board_requested_positions integer[] := array[]::integer[];
  board_requested_column jsonb;
  board_option_position integer;
begin
  board_summary_mode := p_choice_field_id is not null;
  board_choice_field_id := p_choice_field_id::text;
  pivot_mode := p_pivot_row_field_id is not null;
  pivot_row_field_id := p_pivot_row_field_id::text;
  pivot_column_field_id := p_pivot_column_field_id::text;
  pivot_measure_field_id := p_pivot_measure_field_id::text;
  pivot_buckets := coalesce(p_buckets, '{}'::jsonb);
  resolved := prepared_plan -> 'resolved';
  query_item := p_query;
  record_type_item := prepared_plan -> 'recordType';
  if record_type_item ? 'systemProjection' then
    -- A protected reader supplies bounded pages, not an unbounded relation
    -- for aggregate scans.
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  -- A group continuation is the jsonb text [rank, title, canonical group value] of the last group
  -- a page returned, for pivot rows and grouped tables alike; anything else is forged.
  if group_after is not null then
    begin
      group_cursor := group_after::jsonb;
      if pg_catalog.jsonb_typeof(group_cursor) <> 'array'
        or pg_catalog.jsonb_array_length(group_cursor) <> 3
        or (group_cursor ->> 0) not in ('0', '1', '2')
        or pg_catalog.jsonb_typeof(group_cursor -> 0) <> 'number'
        or pg_catalog.jsonb_typeof(group_cursor -> 1) <> 'string'
        or pg_catalog.jsonb_typeof(group_cursor -> 2) <> 'string' then
        raise exception using errcode = '22023', message = 'Group cursor is not a group key';
      end if;
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end;
  end if;
  -- Every grouped read pages its groups: the requested page size, or the default, held to the maximum.
  -- The candidate ceiling bounds the rows a read may scan, never the groups it returns.
  group_page_limit := least(group_page_maximum, greatest(1, coalesce(p_group_limit, group_page_default)));
  if pg_catalog.jsonb_typeof(declared_searchable_ids) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(declared_searchable_ids) > 200 or exists (
    select 1 from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'string' or pg_catalog.lower(item.value #>> '{}') !~ uuid_pattern
  ) or (select pg_catalog.count(*) <> pg_catalog.count(distinct pg_catalog.lower(item.value #>> '{}'))
        from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 10
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if board_summary_mode
    and pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb)) as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  select coalesce(pg_catalog.array_agg(field.key), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_each(fields_by_id) as field(key, value)
  where field.value ->> 'searchPriority' in ('first', 'normal', 'last')
    and (pg_catalog.jsonb_array_length(declared_searchable_ids) = 0 or exists (
      select 1 from pg_catalog.jsonb_array_elements_text(declared_searchable_ids) as selected(id)
      where pg_catalog.lower(selected.id) = field.key
    ));

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    field_key := pg_catalog.lower(field_item #>> '{}');
    field_type := coalesce(fields_by_id -> field_key ->> 'type', '');
    if field_key = any (group_ids)
      or field_type not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    group_ids := pg_catalog.array_append(group_ids, field_key);
    if not (field_key = any (summary_field_ids)) then
      summary_field_ids := pg_catalog.array_append(summary_field_ids, field_key);
      fast_field_ids := pg_catalog.array_append(fast_field_ids, field_key);
    end if;
  end loop;

  if board_summary_mode then
    if pg_catalog.cardinality(group_ids) <> 1
      or group_ids[1] is distinct from board_choice_field_id
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true
      or pg_catalog.jsonb_typeof(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) is distinct from 'array'
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) as selected(value)
        where pg_catalog.jsonb_typeof(selected.value) = 'string'
          and pg_catalog.lower(selected.value #>> '{}') = board_choice_field_id
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if board_option - array['value', 'label', 'tone', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
  end if;

  aggregate_items := coalesce(query_item -> 'aggregates', '[]'::jsonb);
  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    if aggregate_operation not in ('count', 'sum', 'minimum', 'maximum', 'average', 'distinct_count')
      or aggregate_alias is null
      or aggregate_alias !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(aggregate_alias) > 40
      or aggregate_alias = any (aggregate_aliases)
      or (aggregate_item ? 'fieldId' and aggregate_field_id is null)
      or (aggregate_operation <> 'count' and aggregate_field_id is null)
      or (aggregate_operation = 'count' and aggregate_field_id is not null and not p_field_counts) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    aggregate_aliases := pg_catalog.array_append(aggregate_aliases, aggregate_alias);
    if aggregate_field_id is not null then
      if aggregate_field_id !~ uuid_pattern or not (fields_by_id ? aggregate_field_id) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_operation = 'distinct_count'
        and (fields_by_id -> aggregate_field_id ->> 'filterable')::boolean is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if aggregate_original_field_type = 'calculation' then
        if coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,expression,op}', '') not in ('add', 'subtract', 'multiply', 'divide', 'round')
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if (aggregate_operation in ('sum', 'average')
          and aggregate_field_type not in ('whole_number', 'decimal_number', 'money'))
        or (aggregate_operation in ('minimum', 'maximum')
          and aggregate_field_type not in (
            'text', 'whole_number', 'decimal_number', 'yes_no', 'money', 'date', 'date_time'
          )) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if not (aggregate_field_id = any (summary_field_ids)) then
        summary_field_ids := pg_catalog.array_append(summary_field_ids, aggregate_field_id);
        fast_field_ids := pg_catalog.array_append(fast_field_ids, aggregate_field_id);
      end if;
    end if;
  end loop;

  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := coalesce(prepared_plan #>> '{access,predicate}', 'true');
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  -- The fields the reader is guaranteed to see on every record it may read: the bound a grouped
  -- table offers its filter, search and sort controls by, as a plain page read reports it.
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where fields_by_id ? item.value;
  if p_grouping_field_id is not null and not (
    p_grouping_field_id::text = any (readable_field_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  -- A pivot axis or measure withheld from the viewer on any record is refused, so a withheld
  -- value never appears as a row, a column or a measure.
  if pivot_mode and not (
    pivot_row_field_id = any (readable_field_ids)
    and pivot_column_field_id = any (readable_field_ids)
    and (pivot_measure_field_id is null or pivot_measure_field_id = any (readable_field_ids))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_filter, coalesce(pg_catalog.to_jsonb(p_filterable_field_ids), '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  -- The compiler already applied an exact predicate over guaranteed readable
  -- columns. Re-evaluating it for each selected row adds no decision.
  if (prepared_plan #>> '{filter,pushedExact}')::boolean is true then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value order by item.position), array[]::text[])
  into filter_expression_pairs
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}')
    with ordinality as item(value, position);
  if pg_catalog.cardinality(filter_expression_pairs) > 0 then
    select pg_catalog.string_agg(
      'pg_catalog.jsonb_build_object(' || chunk.pairs_text || ')', ' || '
      order by chunk.chunk_index
    )
    into filter_values_sql
    from (
      select (pair.position - 1) / 50 as chunk_index,
        pg_catalog.string_agg(pair.value, ', ' order by pair.position) as pairs_text
      from pg_catalog.unnest(filter_expression_pairs)
        with ordinality as pair(value, position)
      group by (pair.position - 1) / 50
    ) as chunk;
  end if;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);

  -- The plan is exact only when every candidate is readable and every field
  -- used by grouping, aggregates or filtering is readable on every candidate.
  -- Derived filter and aggregate fields can lose their projection on an
  -- individual record when an input is withheld, so both require read_record.
  -- A search may match through a field readable on only some records; read_record
  -- remains authoritative for each match rather than searching hidden stored values.
  fast_path := user_search is null and pg_catalog.cardinality(readable_field_ids) > 0
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as required(id)
      where fields_by_id -> required.id ->> 'type' in ('calculation', 'total')
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and fields_by_id -> pg_catalog.lower(item.value ->> 'fieldId') ->> 'type'
          in ('calculation', 'total')
    )
    and not exists (
      select 1 from pg_catalog.unnest(group_ids || filter_ids) as required(id)
      where required.id <> all (readable_field_ids)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and pg_catalog.lower(item.value ->> 'fieldId') <> all (readable_field_ids)
    );

  if fast_path then
    foreach field_key in array fast_field_ids loop
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        fast_path_fields_valid := false;
        exit;
      end if;
      field_type := fields_by_id -> field_key ->> 'type';
      fast_path_fields_valid := fast_path_fields_valid and case field_type
        when 'whole_number' then mapping_row.database_value_type = 'integer'
        when 'decimal_number' then mapping_row.database_value_type = 'decimal'
        when 'yes_no' then mapping_row.database_value_type = 'boolean'
        when 'date' then mapping_row.database_value_type = 'date'
        when 'date_time' then mapping_row.database_value_type = 'timestamp_with_time_zone'
        when 'money' then mapping_row.database_value_type = 'json'
        when 'link' then mapping_row.database_value_type = 'json'
        when 'link_to_one_of_several' then mapping_row.database_value_type = 'json'
        when 'text' then mapping_row.database_value_type = 'text'
        when 'long_text' then mapping_row.database_value_type = 'text'
        when 'formatted_text' then mapping_row.database_value_type = 'json'
        when 'choice' then mapping_row.database_value_type = 'text'
        when 'reference_number' then mapping_row.database_value_type = 'text'
        when 'email_address' then mapping_row.database_value_type = 'text'
        when 'phone_number' then mapping_row.database_value_type = 'text'
        when 'web_address' then mapping_row.database_value_type = 'text'
        when 'several_choices' then mapping_row.database_value_type = 'json'
        when 'table' then mapping_row.database_value_type = 'json'
        when 'attachment' then mapping_row.database_value_type = 'json'
        else false end;
      if not fast_path_fields_valid then
        exit;
      end if;
      value_expression := case mapping_row.database_value_type
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
          mapping_row.physical_column_token
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          mapping_row.physical_column_token
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
      end;
      expression_pairs := pg_catalog.array_append(
        expression_pairs, pg_catalog.format('%L, %s', field_key, value_expression)
      );
    end loop;
    fast_path := fast_path_fields_valid;
  end if;

  -- A search narrows the candidate scan, and so the ceiling, through the one shared
  -- stored-value pre-predicate; read_record stays the decision for each counted match.
  search_prefilter_sql := vortex_record.query_search_prefilter_internal(
    v_storage_contract_id, fields_by_id, search_field_ids, readable_field_ids, user_search, 18, 19
  );

  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    aggregate_count_sql := 'pg_catalog.count(*)';
    aggregate_present_sql := 'true';
    aggregate_value_sql := 'pg_catalog.to_jsonb(pg_catalog.count(*))';
    aggregate_mixed_currency_sql := 'false';
    if aggregate_field_id is not null then
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_original_field_type = 'calculation' then
        if coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,expression,op}', '') not in ('add', 'subtract', 'multiply', 'divide', 'round')
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_present_sql := pg_catalog.format(
        '(candidate.projected_values ? %L and candidate.projected_values -> %L <> ''null''::jsonb)',
        aggregate_field_id, aggregate_field_id
      );
      aggregate_count_sql := pg_catalog.format(
        'pg_catalog.count(*) filter (where %s)', aggregate_present_sql
      );
      value_expression := pg_catalog.format('(candidate.projected_values -> %L)', aggregate_field_id);
      aggregate_currency_sql := pg_catalog.format(
        '(candidate.projected_values -> %L ->> ''currency'')', aggregate_field_id
      );
      aggregate_amount_sql := pg_catalog.format(
        '((candidate.projected_values -> %L ->> ''amount'')::numeric)', aggregate_field_id
      );
      if aggregate_operation = 'count' then
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', aggregate_count_sql);
      elsif aggregate_operation = 'distinct_count' then
        -- SQL numeric equality folds differently scaled exact decimal text. Money
        -- includes its currency; counting different values never adds currencies.
        value_expression := case aggregate_field_type
          when 'decimal_number' then pg_catalog.format(
            'pg_catalog.to_jsonb((candidate.projected_values ->> %L)::numeric)', aggregate_field_id)
          when 'money' then pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', %s)',
            aggregate_amount_sql, aggregate_currency_sql)
          else value_expression end;
        aggregate_value_sql := pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.count(distinct %s) filter (where %s))',
          value_expression, aggregate_present_sql
        );
      elsif aggregate_field_type = 'money' then
        aggregate_mixed_currency_sql := pg_catalog.format(
          '(pg_catalog.count(distinct %s) filter (where %s)) > 1',
          aggregate_currency_sql, aggregate_present_sql
        );
        if aggregate_operation = 'minimum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s asc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        elsif aggregate_operation = 'maximum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s desc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        else
          average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
          if average_places not between 0 and 12 then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
          end if;
          if aggregate_operation = 'sum' then
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale(pg_catalog.sum(%s) filter (where %s))::text',
              aggregate_amount_sql, aggregate_present_sql
            );
          else
            aggregate_sum_sql := pg_catalog.format(
              'pg_catalog.sum(%s) filter (where %s)', aggregate_amount_sql, aggregate_present_sql
            );
            aggregate_average_sql := pg_catalog.format(
              'case when %3$s = 0 then null else
                 pg_catalog.sign(%1$s) * (
                   pg_catalog.div(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   )
                   + case when 2 * pg_catalog.mod(
                       pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                       (%3$s)::numeric
                     ) >= (%3$s)::numeric then 1 else 0 end
                 ) / pg_catalog.power(10::numeric, %2$s)
               end',
              aggregate_sum_sql, average_places, aggregate_count_sql
            );
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
            );
          end if;
          aggregate_value_sql := pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', (pg_catalog.array_agg(%s order by %s collate "C" asc) filter (where %s))[1])',
            value_expression, aggregate_currency_sql, aggregate_currency_sql, aggregate_present_sql
          );
        end if;
      elsif aggregate_operation in ('minimum', 'maximum') then
        if aggregate_field_type = 'text' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L) collate "C" %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'yes_no' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L)::boolean %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'whole_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s((candidate.projected_values ->> %L)::bigint) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'decimal_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.trim_scale(pg_catalog.%s((candidate.projected_values ->> %L)::numeric) filter (where %s))::text)',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'date' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s(candidate.projected_values ->> %L) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        else
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(pg_catalog.%s((candidate.projected_values ->> %L)::timestamp with time zone) filter (where %s)))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        end if;
        aggregate_value_sql := value_expression;
      else
        average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
        if aggregate_operation = 'average' and average_places not between 0 and 12 then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        if aggregate_operation = 'sum' then
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale(pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s))::text',
            aggregate_field_id, aggregate_present_sql
          );
        else
          aggregate_sum_sql := pg_catalog.format(
            'pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s)',
            aggregate_field_id, aggregate_present_sql
          );
          aggregate_average_sql := pg_catalog.format(
            'case when %3$s = 0 then null else
               pg_catalog.sign(%1$s) * (
                 pg_catalog.div(
                   pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                   (%3$s)::numeric
                 )
                 + case when 2 * pg_catalog.mod(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   ) >= (%3$s)::numeric then 1 else 0 end
               ) / pg_catalog.power(10::numeric, %2$s)
             end',
            aggregate_sum_sql, average_places, aggregate_count_sql
          );
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
          );
        end if;
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', value_expression);
      end if;
      if aggregate_operation in ('count', 'distinct_count') then
        aggregate_result_sql := pg_catalog.format(
          'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', %s)',
          aggregate_count_sql, aggregate_value_sql
        );
      else
        aggregate_result_sql := pg_catalog.format(
          'case when %s then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''mixed_currency'') else pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', case when %s = 0 then ''null''::jsonb else %s end) end',
          aggregate_mixed_currency_sql, aggregate_count_sql, aggregate_count_sql, aggregate_value_sql
        );
      end if;
    else
      aggregate_result_sql := pg_catalog.format(
        'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', pg_catalog.count(*), ''value'', pg_catalog.to_jsonb(pg_catalog.count(*)))'
      );
    end if;
    -- A missing projected key is withheld, whereas a readable empty field remains JSON null.
    -- Never present a partial total (or an empty total) as the aggregate of the whole bucket.
    if aggregate_field_id is not null then
      aggregate_result_sql := pg_catalog.format(
        'case when coalesce(pg_catalog.bool_or(not (candidate.projected_values ? %L)), false)
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''read_forbidden'')
           else %s end',
        aggregate_field_id, aggregate_result_sql
      );
    end if;
    if aggregate_object_sql <> '' then
      aggregate_object_sql := aggregate_object_sql || ', ';
    end if;
    aggregate_object_sql := aggregate_object_sql || pg_catalog.format('%L, %s', aggregate_alias, aggregate_result_sql);
  end loop;

  -- A count-only grouping has no authored aggregate expressions. Its totals
  -- must still be exactly one row when the selection is empty or over budget.
  summary_totals_sql := case when aggregate_object_sql = '' then
    'select ''{}''::jsonb as aggregate_values'
    else pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as aggregate_values from selected as candidate',
      aggregate_object_sql) end;

  foreach field_key in array group_ids loop
    group_bucket := nullif(pivot_buckets -> field_key, 'null'::jsonb);
    group_value_sql := pg_catalog.format(
      'vortex_record.grouping_value_internal(candidate.projected_values -> %L, %L, %L::jsonb)',
      field_key, fields_by_id -> field_key ->> 'type', group_bucket::text
    );
    group_value_pairs := pg_catalog.array_append(
      group_value_pairs, pg_catalog.format('%L, %s', field_key, group_value_sql)
    );
    group_by_terms := pg_catalog.array_append(group_by_terms, group_value_sql);
    group_presence_terms := pg_catalog.array_append(
      group_presence_terms, pg_catalog.format('(candidate.projected_values ? %L)', field_key)
    );
  end loop;
  group_values_sql := 'pg_catalog.jsonb_build_object(' || pg_catalog.array_to_string(group_value_pairs, ', ') || ')';
  group_presence_sql := pg_catalog.array_to_string(group_presence_terms, ' and ');
  -- A grouped table orders its groups by the tuple of (rank, title) per group field, in
  -- groupByFieldIds order, then the canonical value. A link dimension takes its rank and title from
  -- one protected title batch per link field (the batch pivot axes use), so unreadable targets fold
  -- into one Not available value per field. A choice dimension follows the field's option order: a
  -- stored value the field no longer offers follows every option, and no value comes last (rank 1,
  -- as for a link). Every other dimension keeps its canonical value order. The first field's rank is
  -- the group's rank; every field's title (terminated, the later ones led by their rank) is the
  -- group's title, so the keyset cursor stays [rank, title, canonical value].
  group_axis_ctes_sql := '';
  foreach field_key in array group_ids loop
    group_axis_index := group_axis_index + 1;
    group_field_type := fields_by_id -> field_key ->> 'type';
    if group_field_type = 'link' then
      group_axis_ctes_sql := group_axis_ctes_sql || pg_catalog.format(
        'link_axis_%1$s as materialized (
           select * from vortex_record.dimension_value_internal(
             (select pg_catalog.array_agg(distinct raw.group_values -> %2$L) from raw_dimensions as raw), %3$L::jsonb
           )
         ), ',
        group_axis_index, field_key, (fields_by_id -> field_key)::text
      );
      group_axis_joins_sql := group_axis_joins_sql || pg_catalog.format(
        ' left join link_axis_%1$s on link_axis_%1$s.value = raw.group_values -> %2$L',
        group_axis_index, field_key
      );
      group_axis_normalized := pg_catalog.format('link_axis_%s.normalized', group_axis_index);
      group_axis_rank := pg_catalog.format('coalesce(link_axis_%s.sort_rank, 0)', group_axis_index);
      group_axis_title := pg_catalog.format('coalesce(link_axis_%s.sort_title, '''')', group_axis_index);
    elsif group_field_type = 'choice' then
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := pg_catalog.format(
        'case when coalesce(raw.group_values -> %L, ''null''::jsonb) = ''null''::jsonb then 1 else 0 end', field_key
      );
      group_axis_title := pg_catalog.format(
        'case when coalesce(raw.group_values -> %1$L, ''null''::jsonb) = ''null''::jsonb then ''''::text
           else coalesce((
             select pg_catalog.lpad(choice_option.ordinal::text, 4, ''0'')
             from pg_catalog.jsonb_array_elements(%2$L::jsonb) with ordinality as choice_option(item, ordinal)
             where choice_option.item ->> ''value'' = raw.group_values ->> %1$L
             order by choice_option.ordinal limit 1
           ), ''9999'') end',
        field_key, coalesce(fields_by_id #> array[field_key, 'settings', 'options'], '[]'::jsonb)::text
      );
    else
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := '0';
      group_axis_title := '''''::text';
    end if;
    group_axis_normalized_pairs := pg_catalog.array_append(
      group_axis_normalized_pairs, pg_catalog.format('%L, %s', field_key, group_axis_normalized)
    );
    group_axis_title_terms := pg_catalog.array_append(
      group_axis_title_terms,
      case when group_axis_index = 1 then '' else '(' || group_axis_rank || ')::text || ' end
        || pg_catalog.format('pg_catalog.translate(pg_catalog.left(%s, 256), pg_catalog.chr(1), '''') || pg_catalog.chr(1)', group_axis_title)
    );
    if group_axis_index = 1 then group_first_rank_sql := group_axis_rank; end if;
  end loop;
  group_dimension_sql := pg_catalog.format(
    'select raw.group_values as value, pg_catalog.jsonb_build_object(%s) as normalized,
       %s as sort_rank, %s as sort_title
     from (select distinct group_values from raw_dimensions) as raw%s',
    pg_catalog.array_to_string(group_axis_normalized_pairs, ', '),
    group_first_rank_sql,
    pg_catalog.array_to_string(group_axis_title_terms, ' || '),
    group_axis_joins_sql
  );

  if fast_path then
    candidate_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as projected_values,
         %s as filter_values
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
       limit $5',
      pg_catalog.array_to_string(expression_pairs, ', '),
      filter_values_sql,
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate
    );
  else
    -- The access predicate supplies only the planner's candidate superset.
    -- Decide every scanned row through read_record before evaluating its Query
    -- filter, so a withheld field can never decide whether it counts.
    scan_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
         and (%s)
       limit $5',
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate,
      search_prefilter_sql
    );
    candidate_sql := scan_sql;
  end if;

  -- A compiled predicate may be a superset. The fast path still evaluates the
  -- complete condition over values the exact plan proves readable; the raw
  -- candidate count remains the ceiling, before any totals are returned.
  if fast_path then
    selected_sql := case when filter_condition is not null then
      'select candidate.projected_values from candidate where
         vortex_access.evaluate_query_condition_internal(
           $12, $13, candidate.filter_values, $14, $15, false
         )'
      else 'select candidate.projected_values from candidate' end;
  else
    -- Decide the candidates together, one set pass per batch, and materialize each read once.
    -- The raw candidate count gates the reads, and every filter and aggregate uses only the
    -- fields this read returned.
    selected_sql := pg_catalog.format(
      'with readable as materialized (
         select batch.result
         from vortex_record.read_record_batch_internal(
           %L::uuid,
           (select pg_catalog.array_agg(candidate.record_id) from candidate
             where (select value from candidate_count) <= %s),
           %L::boolean, %L::uuid, %L::jsonb
         ) as batch
       )
       select (
         select coalesce(pg_catalog.jsonb_object_agg(field.id, readable.result -> ''values'' -> field.id), ''{}''::jsonb)
         from pg_catalog.unnest($17::text[]) as field(id)
         where readable.result -> ''values'' ? field.id
       ) as projected_values
       from readable
       where readable.result ->> ''outcome'' = ''allowed''
         and vortex_record.query_search_matches_internal(readable.result -> ''values'', $18::text[], $19::text)
         and not exists (
           select 1 from pg_catalog.unnest($16::text[]) as required(id)
           where not (readable.result -> ''values'' ? required.id)
         )
         and ($12::jsonb is null or vortex_access.evaluate_query_condition_internal(
           $12, $13,
           (select coalesce(pg_catalog.jsonb_object_agg(referenced.id,
             case $13 ->> referenced.id
               when ''organization_account_reference'' then pg_catalog.to_jsonb(
                 pg_catalog.lower(readable.result -> ''values'' -> referenced.id ->> ''organizationAccountId''))
               else readable.result -> ''values'' -> referenced.id
             end), ''{}''::jsonb)
            from pg_catalog.unnest($16::text[]) as referenced(id)),
           $14, $15, false
         ))',
      record_type_id_value::text, summary_candidate_limit,
      prepared_plan ? 'preview', v_storage_contract_id::text,
      case when prepared_plan ? 'preview' then record_type_item::text end
    );
  end if;

  -- Omitted grouping fields are withheld on that row, so they form no group;
  -- a readable JSON null remains a legitimate null group.
  if board_summary_mode then
    for board_requested_column in
      select item.value from pg_catalog.jsonb_array_elements(board_requested_columns) as item(value)
    loop
      if board_requested_column ->> 'kind' = 'unassigned' then
        board_requested_positions := pg_catalog.array_append(board_requested_positions, 0);
      else
        board_option_position := pg_catalog.array_position(board_option_values, board_requested_column ->> 'value');
        if board_option_position is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        board_requested_positions := pg_catalog.array_append(board_requested_positions, board_option_position);
      end if;
    end loop;

  end if;
  return pg_catalog.jsonb_build_object('outcome', 'planned')
    || pg_catalog.jsonb_build_object('summary_candidate_limit', pg_catalog.to_jsonb(summary_candidate_limit),
      'resolved', pg_catalog.to_jsonb(resolved),
      'fast_path', pg_catalog.to_jsonb(fast_path),
      'candidate_sql', pg_catalog.to_jsonb(candidate_sql),
      'selected_sql', pg_catalog.to_jsonb(selected_sql),
      'aggregate_object_sql', pg_catalog.to_jsonb(aggregate_object_sql),
      'board_choice_field_id', pg_catalog.to_jsonb(board_choice_field_id),
      'board_options', pg_catalog.to_jsonb(board_options),
      'board_requested_positions', pg_catalog.to_jsonb(board_requested_positions),
      'p_module_root_id', pg_catalog.to_jsonb(p_module_root_id),
      'p_query_id', pg_catalog.to_jsonb(p_query_id),
      'group_ids', pg_catalog.to_jsonb(group_ids),
      'fields_by_id', pg_catalog.to_jsonb(fields_by_id),
      'group_by_terms', pg_catalog.to_jsonb(group_by_terms),
      'group_page_limit', pg_catalog.to_jsonb(group_page_limit),
      'group_after', pg_catalog.to_jsonb(group_after),
      'group_cursor', pg_catalog.to_jsonb(group_cursor),
      'pivot_row_field_id', pg_catalog.to_jsonb(pivot_row_field_id),
      'pivot_column_field_id', pg_catalog.to_jsonb(pivot_column_field_id),
      'pivot_column_limit', pg_catalog.to_jsonb(pivot_column_limit),
      'group_presence_sql', pg_catalog.to_jsonb(group_presence_sql),
      'group_values_sql', pg_catalog.to_jsonb(group_values_sql),
      'group_dimension_sql', pg_catalog.to_jsonb(group_dimension_sql),
      'group_axis_ctes_sql', pg_catalog.to_jsonb(group_axis_ctes_sql),
      'summary_totals_sql', pg_catalog.to_jsonb(summary_totals_sql),
      'user_search', pg_catalog.to_jsonb(user_search),
      'search_field_ids', pg_catalog.to_jsonb(search_field_ids),
      'context_organization_id', pg_catalog.to_jsonb(context_organization_id),
      'context_application_root_id', pg_catalog.to_jsonb(context_application_root_id),
      'access_parameters', pg_catalog.to_jsonb(access_parameters),
      'access_owner_account_id', pg_catalog.to_jsonb(access_owner_account_id),
      'access_owner_group_ids', pg_catalog.to_jsonb(access_owner_group_ids),
      'access_shared_record_ids', pg_catalog.to_jsonb(access_shared_record_ids),
      'bound_field_ids', pg_catalog.to_jsonb(bound_field_ids),
      'filter_condition', pg_catalog.to_jsonb(filter_condition))
    || pg_catalog.jsonb_build_object('filter_types', pg_catalog.to_jsonb(filter_types),
      'parameter_types', pg_catalog.to_jsonb(parameter_types),
      'parameter_values', pg_catalog.to_jsonb(parameter_values),
      'filter_ids', pg_catalog.to_jsonb(filter_ids),
      'filter_parameters', pg_catalog.to_jsonb(filter_parameters),
      'summary_field_ids', pg_catalog.to_jsonb(summary_field_ids))
  ;
end
$function$;

alter function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb) to vortex_record_adapter;

reset role;
