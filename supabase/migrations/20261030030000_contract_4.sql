-- Contract 4 (Epic 1 #3660, SF-C #3743): one definition contract version, 4.0.0, for applications,
-- modules and record types. Stored drafts are converted in place below; active installations move
-- to a contract-4 release through the setup refresh (publication and the installation coordinator);
-- old releases stay as sealed history. Privileges are unchanged.
set local role vortex_owner;

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
      return array['4.0.0'];
    when 'module' then
      return array['4.0.0'];
    when 'record_type' then
      return array['4.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

reset role;

-- BeforeSave flows run in the order of the record type's ordered rule list (no hidden priority).
-- Record functions retain the restricted adapter owner.
set local role vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.before_save_flows_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  release_content jsonb;
  record_type jsonb;
begin
  if p_module_root_id is null or p_module_release_revision is null
    or p_record_type_id is null then
    raise exception using errcode = '22023', message = 'Before-save flow selector is invalid';
  end if;
  select release.record_content
  into strict release_content
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision;
  select item.value
  into record_type
  from pg_catalog.jsonb_array_elements(
    coalesce(release_content -> 'recordTypes', '[]'::jsonb)
  ) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  -- The record type's ordered rule list is the run order; a release without one cannot be saved
  -- through, so a missing list refuses the save instead of skipping its rules.
  if record_type is null
    or pg_catalog.jsonb_typeof(record_type -> 'beforeSaveFlowIds') is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Before-save flow selector names no record type with an ordered rule list';
  end if;
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'releaseRevision', p_module_release_revision,
    'flows', coalesce((
      select pg_catalog.jsonb_agg(flow.value order by listed.ordinality)
      from pg_catalog.jsonb_array_elements_text(
        record_type -> 'beforeSaveFlowIds'
      ) with ordinality as listed(flow_id, ordinality)
      join pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'flows', '[]'::jsonb)
      ) as flow(value)
        on pg_catalog.lower(flow.value ->> 'id') = pg_catalog.lower(listed.flow_id)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(flow.value -> 'triggers', '[]'::jsonb)
        ) as trigger(value)
        where trigger.value ->> 'type' = 'BeforeSave'
          and pg_catalog.lower(trigger.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text)
      )
    ), '[]'::jsonb)
  );
end
$$;

comment on function vortex_record.before_save_flows_for_record_type_internal(uuid, bigint, uuid) is
  'Private save step: returns the exact Module release identity and every BeforeSave flow of that release that names the given record type, in the record type''s ordered rule list, read from the immutable release row the save already resolved.';

reset role;
