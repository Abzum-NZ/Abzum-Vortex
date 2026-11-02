-- FIX-EXPORT-DISPLAY: a Table's Export setting names the columns that download raw values.
--
-- Contract 4.6.0: every Table's `features.export` group carries `raw_columns`, the list of columns
-- whose file holds the stored value instead of what the table shows (empty by default). Every
-- stored draft moves to 4.6.0 and gains an empty `raw_columns` in each Export group that lacks it,
-- once. Releases published under 4.5.0 stay as history through the superseded-contract path.
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
      return array['4.6.0'];
    when 'module' then
      return array['4.6.0'];
    when 'record_type' then
      return array['4.6.0'];
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

create function pg_temp.raw_columns_canonical_json(p_value jsonb)
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
          || pg_temp.raw_columns_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(
          pg_temp.raw_columns_canonical_json(item.value), ',' order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.raw_columns_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_temp.raw_columns_canonical_json(p_value), 'UTF8')),
    'hex'
  )
$function$;

-- The one value this change adds, at any depth: an Export group inside a `features` group.
create function pg_temp.raw_columns_source(p_value jsonb, p_parent text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  rewritten jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      select pg_catalog.jsonb_object_agg(
        member.key, pg_temp.raw_columns_source(member.value, member.key)
      ) into rewritten
      from pg_catalog.jsonb_each(p_value) as member(key, value);
      rewritten := coalesce(rewritten, '{}'::jsonb);
      if p_parent = 'features' and pg_catalog.jsonb_typeof(rewritten -> 'export') = 'object'
        and not (rewritten -> 'export') ? 'raw_columns' then
        rewritten := pg_catalog.jsonb_set(
          rewritten, '{export,raw_columns}', '{"kind": "list", "items": []}'::jsonb
        );
      end if;
      return rewritten;
    when 'array' then
      select pg_catalog.jsonb_agg(
        pg_temp.raw_columns_source(item.value, p_parent) order by item.ordinality
      ) into rewritten
      from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return coalesce(rewritten, '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

do $convert$
declare
  stored record;
  converted jsonb;
begin
  for stored in
    select d.root_id, r.key, d.draft_source as source, d.source_fingerprint as fingerprint
    from vortex_definition.drafts as d
    join vortex_definition.roots as r on r.root_id = d.root_id
  loop
    if pg_temp.raw_columns_fingerprint(stored.source) is distinct from stored.fingerprint then
      raise exception 'Contract 4.6.0 cannot verify the stored fingerprint of draft % (%)',
        stored.key, stored.root_id;
    end if;
  end loop;
  for stored in
    select d.root_id, d.draft_source
    from vortex_definition.drafts as d
    order by d.root_id
  loop
    converted := pg_catalog.jsonb_set(
      pg_temp.raw_columns_source(stored.draft_source, ''),
      '{source_contract_version}', '"4.6.0"'::jsonb
    );
    update vortex_definition.drafts as d set
      draft_source = converted,
      source_contract_version = '4.6.0',
      source_fingerprint = pg_temp.raw_columns_fingerprint(converted),
      draft_revision = d.draft_revision + 1,
      updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
      restored_from_release_revision = null,
      restored_from_source_fingerprint = null,
      restored_by = null, restored_at = null, restore_correlation_id = null
    where d.root_id = stored.root_id;
  end loop;
end
$convert$;

drop function pg_temp.raw_columns_source(jsonb, text);
drop function pg_temp.raw_columns_fingerprint(jsonb);
drop function pg_temp.raw_columns_canonical_json(jsonb);

reset role;
