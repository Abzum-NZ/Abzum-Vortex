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
      return array['4.4.0'];
    when 'module' then
      return array['4.4.0'];
    when 'record_type' then
      return array['4.4.0'];
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

-- Contract 4.4.0: the theme contract holds only the tokens a component reads, so an authored theme
-- no longer carries a loader mark. Every stored draft moves to 4.4.0 and loses its
-- `theme.loader_mark` in place, once. Releases published under 4.3.0 stay as history through the
-- superseded-contract path.
create function pg_temp.contract_44_canonical_json(p_value jsonb)
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
          || pg_temp.contract_44_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(pg_temp.contract_44_canonical_json(item.value), ',' order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.contract_44_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_temp.contract_44_canonical_json(p_value), 'UTF8')),
    'hex'
  )
$function$;

-- One authored draft: the theme no longer has a loader mark, and the source names the new contract.
create function pg_temp.contract_44_source(p_source jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
begin
  return pg_catalog.jsonb_set(p_source, '{source_contract_version}', '"4.4.0"'::jsonb) #- '{body,theme,loader_mark}';
end
$function$;

do $convert$
declare
  draft record;
  converted jsonb;
begin
  for draft in select d.root_id, r.key, d.draft_source, d.source_fingerprint
    from vortex_definition.drafts d join vortex_definition.roots r on r.root_id = d.root_id
  loop
    if pg_temp.contract_44_fingerprint(draft.draft_source) is distinct from draft.source_fingerprint then
      raise exception 'Contract 4.4.0 cannot verify stored fingerprint of draft % (%)', draft.key, draft.root_id;
    end if;
  end loop;
  for draft in select d.root_id, d.draft_source
    from vortex_definition.drafts d
    order by d.root_id
  loop
    converted := pg_temp.contract_44_source(draft.draft_source);
    update vortex_definition.drafts d set
      draft_source = converted,
      source_contract_version = '4.4.0',
      source_fingerprint = pg_temp.contract_44_fingerprint(converted),
      draft_revision = d.draft_revision + 1,
      updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
      restored_from_release_revision = null,
      restored_from_source_fingerprint = null,
      restored_by = null, restored_at = null, restore_correlation_id = null
    where d.root_id = draft.root_id;
  end loop;
end
$convert$;

drop function pg_temp.contract_44_source(jsonb);
drop function pg_temp.contract_44_fingerprint(jsonb);
drop function pg_temp.contract_44_canonical_json(jsonb);

reset role;
