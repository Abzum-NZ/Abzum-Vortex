-- B7D-B3b (B7DA-SQL-1): the exposure rule of a Module query lives in one helper,
-- vortex_record.module_query_is_readable_internal, which answers true or false (never null: a query
-- without an exposure is private). An Application reads a query of a Module it only uses when that
-- Module exposes it (or the query lists a record type by its own identity, or the Application owns
-- the Module). Both query resolvers apply it once the query is found, before anything that depends
-- on the installation, the record type or its storage, and return null, which every caller turns
-- into query_unavailable: a private query, a missing query and an unknown Module answer alike, in a
-- preview with or without an installation and on the installed path. Before this,
-- prepare_module_query_internal applied the rule after the resolver and read_module_query_inputs
-- never applied it, so a private query of another Application's system-projection Module answered
-- installation_required in a Studio preview with no installation, and the installed path returned
-- the input declarations of a private query. The rule is deleted from
-- prepare_module_query_internal (one way only). The grid views' lookup of a query's record type
-- (save_grid_view, grid_view_document_for_viewer_internal) applies the same helper, so a saved or
-- supplied view naming a private query resolves to nothing, like a missing one.
-- No migration rewrites these functions in place (pg_get_functiondef searched): the bodies below
-- are the whole definitions and equal the canonical files in supabase/schemas.
set role vortex_record_adapter;

create or replace function vortex_record.module_query_is_readable_internal(
  p_module_root_id uuid,
  p_query jsonb,
  p_application_root_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  -- The one exposure rule of a Module query, applied once the query is found, before anything that
  -- depends on the installation, the record type or its storage, so a refusal never tells a private
  -- query from a missing one: an Application reads a query of a Module it only uses when that
  -- Module exposes it (the rule the Studio picker, the draft compile and publication apply). A
  -- record type's own listing carries its record type's identity and follows record access
  -- instead. It answers true or false, never null: a query without an exposure is private.
  select coalesce(
      pg_catalog.lower(p_query ->> 'queryId') = pg_catalog.lower(p_query #>> '{recordType,recordTypeId}'),
      false
    )
    or p_query ->> 'exposure' is not distinct from 'exposed'
    or exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = p_application_root_id
    );
$function$;

alter function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  to vortex_owner;

comment on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid) is
  'Private: whether the Application may read one query of a Module (true or false, never null): a record type''s own listing, a query its Module exposes, or any query of a Module the Application owns. The one exposure rule: the installed and preview query resolvers and the grid views'' query lookup apply it.';

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
  installed jsonb;
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
    or query_validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
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
  if vortex_record.module_query_is_readable_internal(
    p_module_root_id, query_item, (installation ->> 'applicationRootId')::uuid
  ) is not true then
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
  if record_type_validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
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
  -- A system projection has no preview copy: it is the platform's live read model, which a
  -- preview reads on the live path under the reader's own live access. Its record type, fields and
  -- permissions are the installed release's, never the draft's: the draft contributes only its
  -- query, and a draft whose record type or permissions differ from the installed ones is refused.
  -- With no installed projection to read (no active installation binding the Module, or one whose
  -- record type or permissions differ from the draft's) installing this draft is what is missing:
  -- the one refusal that names its cause, decided here and passed on unchanged by every caller.
  if record_type_item ? 'systemProjection' then
    installed := vortex_record.read_installed_projection_internal(
      installation, record_type_module_root_id, record_type_id
    );
    if installed is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'installation_required'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'moduleReleaseRevision', query_release_revision,
      'moduleReleaseVersion', query_release_version,
      'query', query_item,
      'recordTypeId', record_type_id,
      'recordTypeModuleRootId', record_type_module_root_id,
      'recordType', installed -> 'recordType'
    );
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

alter function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_preview_module_query_internal(uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_record.resolve_preview_module_query_internal(uuid, uuid) is
  'Private preview-only resolver for one query and its exact pinned record type and active preview storage identity (a system projection resolves the draft''s query over the installed record type with no preview storage, and returns the refusal installation_required when there is no installed projection to read: no active installation binding the Module, or a draft whose record type or permissions differ from it); it returns null, once the query is found and before anything that depends on the installation or the record type, for a query the Application may not read (a private query of another Application''s Module, module_query_is_readable_internal), so no refusal tells a private query from a missing one; it validates the current human-owned unexpired preview and never falls back to an active installation.';

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
  if vortex_record.module_query_is_readable_internal(
    p_module_root_id, query_item, (installation ->> 'applicationRootId')::uuid
  ) is not true then
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


COMMENT ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) IS 'Private: the exact installed Module query and its record type, or null when either is unavailable to the current installation or the Application may not read the query (a private query of another Application''s Module, module_query_is_readable_internal).';

REVOKE ALL ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) FROM PUBLIC;

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  semantic_type text;
  filter_condition jsonb;
  filter_exact boolean := false;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    -- A plan for a system projection is a live plan, in a preview too: see below.
    if preview_mode and not (prepared_plan ? 'preview')
      and prepared_plan -> 'recordType' ? 'systemProjection' then
      preview_mode := false;
    end if;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      -- The preview resolver's own refusal (installation_required) is passed on as it decided it.
      if resolved ->> 'outcome' = 'refused' then
        return resolved;
      end if;
      if resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'fieldBoundIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: it is the platform's live read model, which a
      -- preview reads on the live path, under the reader's own live access and never under the
      -- preview's roles.
      if resolved -> 'recordType' ? 'systemProjection' then
        preview_mode := false;
      end if;
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  -- The preview resolver's own refusal (installation_required) is passed on as it decided it.
  if resolved ->> 'outcome' = 'refused' then
    return resolved;
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      -- A record type of a Module the previewed Application only uses is shared data: the preview
      -- takes the same read plan decision as the installed path, in the preview's registration,
      -- where that Module's own permissions follow the builder's live access. No eligible read
      -- alternative is the same refusal, never an empty preview table. A row the RLS policy does
      -- not show counts as used, so the decision is never skipped.
      if not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (resolved ->> 'recordTypeModuleRootId')::uuid
          and root.kind = 'module'
          and root.owner_application_root_id = context_application_root_id
      ) then
        begin
          select plan.* into access_plan
          from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
        exception
          -- A refused access context or a stale preview is the expected refusal; any
          -- other failure is logged with its cause before the same safe refusal.
          when sqlstate '42501' or sqlstate '40001' then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
          when others then
            get stacked diagnostics failure_sqlstate = returned_sqlstate,
              failure_message = message_text;
            raise warning 'Query preview preparation failed (read plan): SQLSTATE %, %',
              failure_sqlstate, failure_message;
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end;
        if access_plan.access_predicate is null then
          raise warning 'Query preview preparation failed (read plan): no access predicate';
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        if access_plan.access_predicate = 'false' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
        end if;
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The builder's preview field bounds are also the bound a list offers its controls by.
        'fieldBoundIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      -- No eligible read alternative admits any record. Report a refusal before
      -- an empty scan can be mistaken for an empty query result.
      if access_plan.access_predicate = 'false' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The fields the reader is guaranteed to see on every record it may read, whatever the
        -- scan examines: the current field bound a list offers its filter, search and sort by.
        'fieldBoundIds', pg_catalog.to_jsonb(coalesce(access_plan.bound_field_ids, array[]::text[])),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      semantic_type := vortex_access.condition_field_type_internal(fields_by_id -> field_key);
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,op}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- Keep the canonical typed link object, including its target record type.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs retain their canonical values. The bridge validates declared types.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and coalesce((input_item ->> 'required')::boolean, true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  filter_condition := vortex_record.omit_unbound_query_conditions_internal(filter_condition, parameter_values);
  select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_path_query(filter_condition, 'lax $.**?(@.source == "field").fieldId') as referenced(value);

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        8,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, refuses a preview of a used Module''s record type with read_forbidden when the same read plan decision admits no read alternative, refuses a private query of a Module the Application does not own as query_unavailable, like a missing one (decided by the resolvers), validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

reset role;
set role vortex_owner;

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
  -- Resolve only releases pinned by this validated installation, including record-type listings,
  -- and only a query the Application may read (a private query of another Application's Module
  -- resolves to nothing, like a missing one).
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
      and vortex_record.module_query_is_readable_internal(
        (binding.value ->> 'moduleRootId')::uuid, query.value,
        (p_installation ->> 'applicationRootId')::uuid
      )
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
      -- engine's field bounds) and the reader's column
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
    where (query.value ->> 'queryId')::uuid = p_query_id
      -- A private query of another Application's Module resolves to nothing, like a missing one.
      and vortex_record.module_query_is_readable_internal(
        (binding.value ->> 'moduleRootId')::uuid, query.value,
        (installation ->> 'applicationRootId')::uuid
      );
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
