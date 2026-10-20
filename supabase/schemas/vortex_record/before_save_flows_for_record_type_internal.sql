CREATE OR REPLACE FUNCTION vortex_record.before_save_flows_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  release_content jsonb;
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
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'releaseRevision', p_module_release_revision,
    'flows', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'flows', '[]'::jsonb)
      ) with ordinality as item(value, ordinality)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(item.value -> 'triggers', '[]'::jsonb)
        ) as trigger(value)
        where trigger.value ->> 'type' = 'BeforeSave'
          and pg_catalog.lower(trigger.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text)
      )
    ), '[]'::jsonb)
  );
end
$$;
alter function vortex_record.before_save_flows_for_record_type_internal(uuid,bigint,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.before_save_flows_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) IS 'Private save step: returns the exact Module release identity and every BeforeSave flow of that release that names the given record type, read from the immutable release row the save already resolved.';

REVOKE ALL ON FUNCTION vortex_record.before_save_flows_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) FROM PUBLIC;
