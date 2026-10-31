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
                case when option.value ->> 'value' = moved.value ->> 'option'
                  and not (option.value ? 'tone')
                  and moved.value ? 'tone'
                  then pg_catalog.jsonb_set(option.value, '{tone}',
                    pg_catalog.to_jsonb(moved.value ->> 'tone'))
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
    converted := pg_temp.contract_43_assignment_kind(
      pg_temp.contract_43_direct_share(
        pg_temp.contract_43_detail_sections(
          pg_temp.contract_43_groups(
            pg_catalog.jsonb_set(
              pg_catalog.jsonb_set(draft.draft_source, '{body}', body),
              '{source_contract_version}', '"4.3.0"'::jsonb)))));
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
drop function pg_temp.contract_43_fingerprint(jsonb);
drop function pg_temp.contract_43_canonical_json(jsonb);

reset role;
