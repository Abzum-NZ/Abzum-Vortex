-- A link field's automatic input is a record picker (#2854).
-- Every record type can be listed by its own identity: when no authored query of a Module has
-- the requested identity, the installed and preview resolvers return the listing query of the
-- Module's record type with that identity. The picker reads it through the ordinary Query engine,
-- so access, field read policy, search and keyset paging are the engine's own.
set local role vortex_record_adapter;

create or replace function vortex_record.record_type_listing_query_internal(
  p_module_root_id uuid,
  p_record_type jsonb
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  -- Every record type can be listed by its own identity: the query a record picker reads. It
  -- selects only the title, sorts by it and declares no inputs, filter, groups or totals, so the
  -- engine's own access, field read policy, search and keyset paging decide everything it returns.
  select case
    when pg_catalog.jsonb_typeof(p_record_type) = 'object'
      and coalesce(pg_catalog.pg_input_is_valid(p_record_type ->> 'recordTypeId', 'uuid'), false)
      and coalesce(pg_catalog.pg_input_is_valid(p_record_type ->> 'titleFieldId', 'uuid'), false)
      and p_module_root_id is not null
    then pg_catalog.jsonb_build_object(
      'queryId', p_record_type ->> 'recordTypeId',
      'key', 'records',
      'recordType', pg_catalog.jsonb_build_object(
        'state', 'resolved',
        'moduleRootId', p_module_root_id,
        'recordTypeId', p_record_type ->> 'recordTypeId'
      ),
      'inputs', '[]'::jsonb,
      'selectedFieldIds', pg_catalog.jsonb_build_array(p_record_type ->> 'titleFieldId'),
      'filter', null,
      'groupByFieldIds', '[]'::jsonb,
      'aggregates', '[]'::jsonb,
      'sort', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', p_record_type ->> 'titleFieldId', 'direction', 'ascending'
      )),
      'pageSize', 200,
      'relationshipHops', 0
    )
  end
$function$;

alter function vortex_record.record_type_listing_query_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.record_type_listing_query_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.record_type_listing_query_internal(uuid,jsonb) is
  'Private: the query that lists one record type by its own identity (title only, sorted by title, no inputs or filter), which the module query resolvers return when no authored query has that identity.';

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
    or query_contract_version is distinct from '3.0.0'
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  select item.value into query_item
  from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
  where pg_catalog.lower(item.value ->> 'queryId') = pg_catalog.lower(p_query_id::text)
  limit 1;
  -- No authored query has this identity: a record type of this Module, listed by its own.
  if query_item is null then
    select vortex_record.record_type_listing_query_internal(p_module_root_id, item.value)
    into query_item
    from pg_catalog.jsonb_array_elements(
      coalesce(query_content -> 'recordTypes', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_query_id::text)
    limit 1;
  end if;
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

create or replace function vortex_record.resolve_preview_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  module_bindings jsonb;
  storage_identities jsonb;
  preview_installation_id uuid;
  query_binding jsonb;
  query_binding_count bigint;
  query_release_revision_text text;
  query_release_revision bigint;
  query_compilation_output jsonb;
  query_content jsonb;
  query_release_version text;
  query_validation_contract_version text;
  query_source_contract_version text;
  query_item jsonb;
  query_match_count bigint := 0;
  record_type_module_root_id_text text;
  record_type_module_root_id uuid;
  record_type_id_text text;
  record_type_id uuid;
  record_type_binding jsonb;
  record_type_binding_count bigint;
  record_type_release_revision_text text;
  record_type_release_revision bigint;
  record_type_compilation_output jsonb;
  record_type_content jsonb;
  record_type_validation_contract_version text;
  record_type_source_contract_version text;
  record_type_item jsonb;
  record_type_match_count bigint := 0;
  release_storage_contract_id_text text;
  release_storage_contract_id uuid;
  storage_identity jsonb;
  storage_identity_count bigint := 0;
  preview_storage_contract_id_text text;
  preview_storage_contract_id uuid;
  preview_storage_identity_count bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
begin
  if p_module_root_id is null or p_module_root_id = nil_uuid
    or p_query_id is null or p_query_id = nil_uuid then
    return null;
  end if;

  -- The address is transaction-local. This helper validates the human actor,
  -- organisation account, Application, ownership and expiry before returning
  -- the pinned preview; a missing or refused address never selects live state.
  installation := vortex_record.read_current_preview_installation_internal();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) is distinct from 'object'
    or installation ? 'outcome'
    or not coalesce(pg_catalog.pg_input_is_valid(
      installation ->> 'previewInstallationId', 'uuid'
    ), false) then
    return null;
  end if;
  preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
  if preview_installation_id = nil_uuid then
    return null;
  end if;

  module_bindings := installation -> 'moduleBindings';
  storage_identities := installation -> 'storageIdentities';
  if pg_catalog.jsonb_typeof(module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_typeof(storage_identities) is distinct from 'array' then
    return null;
  end if;

  -- Resolve the query only through one exact Module pin in this preview.
  select pg_catalog.count(*)
  into query_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding_count <> 1 then
    return null;
  end if;
  select item.value into query_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  if query_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  query_release_revision_text := query_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(query_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  query_release_revision := query_release_revision_text::bigint;
  if query_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  select release.compilation_output, release.compilation_output #> '{canonical,content}',
    release.release_version, release.validation_contract_version,
    release.source_contract_version
  into query_compilation_output, query_content, query_release_version, query_validation_contract_version,
    query_source_contract_version
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = query_release_revision;
  if not found
    or query_validation_contract_version is distinct from '3.0.0'
    or query_source_contract_version is distinct from query_validation_contract_version
    or query_compilation_output #>> '{kind}' is distinct from 'module'
    or query_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or query_compilation_output #>> '{validationContractVersion}'
      is distinct from query_validation_contract_version
    or pg_catalog.jsonb_typeof(query_content -> 'queries') is distinct from 'array' then
    return null;
  end if;

  for query_item in
    select item.value
    from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
    where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text
  loop
    query_match_count := query_match_count + 1;
  end loop;
  if query_match_count > 1 then
    return null;
  end if;
  if query_match_count = 1 then
    select item.value into query_item
    from pg_catalog.jsonb_array_elements(query_content -> 'queries') as item(value)
    where pg_catalog.lower(item.value ->> 'queryId') = p_query_id::text;
  else
    -- No authored query has this identity: one record type of this Module, listed by its own.
    if pg_catalog.jsonb_typeof(query_content -> 'recordTypes') is distinct from 'array'
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(query_content -> 'recordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') = p_query_id::text
      ) <> 1 then
      return null;
    end if;
    select vortex_record.record_type_listing_query_internal(p_module_root_id, item.value)
    into query_item
    from pg_catalog.jsonb_array_elements(query_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = p_query_id::text;
  end if;
  if pg_catalog.jsonb_typeof(query_item) is distinct from 'object'
    or query_item #>> '{recordType,state}' is distinct from 'resolved' then
    return null;
  end if;

  record_type_module_root_id_text := query_item #>> '{recordType,moduleRootId}';
  record_type_id_text := query_item #>> '{recordType,recordTypeId}';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_module_root_id_text, 'uuid'), false)
    or not coalesce(pg_catalog.pg_input_is_valid(record_type_id_text, 'uuid'), false) then
    return null;
  end if;
  record_type_module_root_id := record_type_module_root_id_text::uuid;
  record_type_id := record_type_id_text::uuid;
  if record_type_module_root_id = nil_uuid or record_type_id = nil_uuid then
    return null;
  end if;

  -- The referenced record type may be in a dependency, but that dependency
  -- must also have one active pin in this same preview installation.
  select pg_catalog.count(*)
  into record_type_binding_count
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding_count <> 1 then
    return null;
  end if;
  select item.value into record_type_binding
  from pg_catalog.jsonb_array_elements(module_bindings) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text;
  if record_type_binding ->> 'state' is distinct from 'active' then
    return null;
  end if;
  record_type_release_revision_text := record_type_binding ->> 'moduleReleaseRevision';
  if not coalesce(pg_catalog.pg_input_is_valid(record_type_release_revision_text, 'bigint'), false) then
    return null;
  end if;
  record_type_release_revision := record_type_release_revision_text::bigint;
  if record_type_release_revision not between 1 and 9007199254740991 then
    return null;
  end if;

  if record_type_module_root_id = p_module_root_id then
    if record_type_release_revision <> query_release_revision then
      return null;
    end if;
    record_type_compilation_output := query_compilation_output;
    record_type_content := query_content;
    record_type_validation_contract_version := query_validation_contract_version;
    record_type_source_contract_version := query_source_contract_version;
  else
    select release.compilation_output, release.compilation_output #> '{canonical,content}',
      release.validation_contract_version, release.source_contract_version
    into record_type_compilation_output, record_type_content, record_type_validation_contract_version,
      record_type_source_contract_version
    from vortex_definition.runtime_releases as release
    where release.root_id = record_type_module_root_id
      and release.release_revision = record_type_release_revision;
    if not found then
      return null;
    end if;
  end if;
  if record_type_validation_contract_version not in ('2.0.0', '3.0.0')
    or record_type_source_contract_version is distinct from record_type_validation_contract_version
    or record_type_compilation_output #>> '{kind}' is distinct from 'module'
    or record_type_compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from record_type_module_root_id::text
    or record_type_compilation_output #>> '{validationContractVersion}'
      is distinct from record_type_validation_contract_version
    or pg_catalog.jsonb_typeof(record_type_content -> 'recordTypes') is distinct from 'array' then
    return null;
  end if;

  for record_type_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
  loop
    record_type_match_count := record_type_match_count + 1;
  end loop;
  if record_type_match_count <> 1 then
    return null;
  end if;
  select item.value into record_type_item
  from pg_catalog.jsonb_array_elements(record_type_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text;
  if pg_catalog.jsonb_typeof(record_type_item) is distinct from 'object'
    or pg_catalog.jsonb_typeof(record_type_item -> 'fields') is distinct from 'array'
    or not coalesce(pg_catalog.pg_input_is_valid(
      record_type_item ->> 'storageContractId', 'uuid'
    ), false) then
    return null;
  end if;
  release_storage_contract_id_text := record_type_item ->> 'storageContractId';
  release_storage_contract_id := release_storage_contract_id_text::uuid;
  if release_storage_contract_id = nil_uuid then
    return null;
  end if;

  -- Match one storage identity against both exact release pins and the
  -- declaration's release storage contract; duplicates or malformed mappings
  -- never choose an arbitrary preview table.
  for storage_identity in
    select item.value
    from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
    where pg_catalog.jsonb_typeof(item.value) = 'object'
      and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
      and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
      and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
      and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text
  loop
    storage_identity_count := storage_identity_count + 1;
  end loop;
  if storage_identity_count <> 1 then
    return null;
  end if;
  select item.value into storage_identity
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'moduleRootId') = record_type_module_root_id::text
    and item.value ->> 'moduleReleaseRevision' = record_type_release_revision::text
    and pg_catalog.lower(item.value ->> 'recordTypeId') = record_type_id::text
    and pg_catalog.lower(item.value ->> 'releaseStorageContractId') = release_storage_contract_id::text;
  preview_storage_contract_id_text := storage_identity ->> 'previewStorageContractId';
  if not coalesce(pg_catalog.pg_input_is_valid(preview_storage_contract_id_text, 'uuid'), false) then
    return null;
  end if;
  preview_storage_contract_id := preview_storage_contract_id_text::uuid;
  if preview_storage_contract_id = nil_uuid then
    return null;
  end if;
  select pg_catalog.count(*)
  into preview_storage_identity_count
  from pg_catalog.jsonb_array_elements(storage_identities) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and pg_catalog.lower(item.value ->> 'previewStorageContractId')
      = preview_storage_contract_id::text;
  if preview_storage_identity_count <> 1 then
    return null;
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = preview_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.module_root_id is distinct from record_type_module_root_id
    or catalogue_row.record_type_id is distinct from record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.first_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.last_compatible_release_revision is distinct from record_type_release_revision
    or catalogue_row.record_type_definition ->> 'storageContractId'
      is distinct from preview_storage_contract_id::text
    or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
      is distinct from record_type_id::text
    or catalogue_row.record_type_definition ->> 'storageScope'
      is distinct from (record_type_item ->> 'storageScope') then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id,
    'moduleRootId', p_module_root_id,
    'moduleReleaseRevision', query_release_revision,
    'moduleReleaseVersion', query_release_version,
    'query', query_item,
    'recordTypeId', record_type_id,
    'recordTypeModuleRootId', record_type_module_root_id,
    'recordTypeModuleReleaseRevision', record_type_release_revision,
    'releaseStorageContractId', release_storage_contract_id,
    'previewStorageContractId', preview_storage_contract_id,
    'storageScope', record_type_item ->> 'storageScope',
    'recordType', record_type_item
  );
end
$function$;
alter function vortex_record.resolve_preview_module_query_internal(uuid,uuid) owner to vortex_record_adapter;


alter function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_record.resolve_preview_module_query_internal(uuid, uuid) is
  'Private preview-only resolver for one query and its exact pinned record type and active preview storage identity; it validates the current human-owned unexpired preview and never falls back to an active installation.';

reset role;
