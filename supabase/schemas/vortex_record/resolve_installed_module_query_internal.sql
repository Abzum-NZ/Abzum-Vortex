CREATE OR REPLACE FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  query_release_revision bigint;
  query_release_version text;
  query_contract_version text;
  query_content jsonb;
  query_item jsonb;
  type_module_root_id uuid;
  type_record_type_id uuid;
  type_release_revision bigint;
  type_content jsonb;
  record_type_item jsonb;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  installation := vortex_definition.read_current_active_installation();

  select (item.value ->> 'moduleReleaseRevision')::bigint
  into query_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = p_module_root_id;
  if query_release_revision is null then
    return null;
  end if;

  select release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version
  into query_content, query_release_version, query_contract_version
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  select item.value into query_item
  from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
  where pg_catalog.lower(item.value ->> 'queryId') = pg_catalog.lower(p_query_id::text)
  limit 1;
  if query_item is null
    or query_item #>> '{recordType,state}' is distinct from 'resolved'
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,moduleRootId}', 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,recordTypeId}', 'uuid'), false) then
    return null;
  end if;
  type_module_root_id := (query_item #>> '{recordType,moduleRootId}')::uuid;
  type_record_type_id := (query_item #>> '{recordType,recordTypeId}')::uuid;

  -- The record type may belong to a declared dependency; it must be bound to
  -- this same installation at its own pinned release.
  select (item.value ->> 'moduleReleaseRevision')::bigint
  into type_release_revision
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = type_module_root_id;
  if type_release_revision is null then
    return null;
  end if;

  if type_module_root_id = p_module_root_id then
    type_content := query_content;
  else
    select release.compilation_output #> '{canonical,content}'
    into type_content
    from vortex_definition.releases as release
    where release.root_id = type_module_root_id
      and release.release_revision = type_release_revision;
  end if;
  if pg_catalog.jsonb_typeof(type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(type_record_type_id::text)
  limit 1;
  if record_type_item is null
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_item ->> 'storageContractId', 'uuid'), false) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', type_record_type_id,
    'recordTypeModuleRootId', type_module_root_id,
    'recordType', record_type_item
  );
end
$$;
alter function vortex_record.resolve_installed_module_query_internal(uuid,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) IS 'Private: the exact installed Module query and its record type, or null when either is unavailable to the current installation.';

REVOKE ALL ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) FROM PUBLIC;
