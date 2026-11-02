create or replace function vortex_record.read_installed_projection_internal(
  p_preview_installation jsonb,
  p_module_root_id uuid,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  application_root_id_value uuid;
  active_installation jsonb;
  installed_module_revision bigint;
  preview_module_revision bigint;
  installed_application_revision bigint;
  preview_application_revision bigint;
  installed_content jsonb;
  installed_record_content jsonb;
  preview_content jsonb;
  preview_record_content jsonb;
  installed_application_content jsonb;
  installed_application_record_content jsonb;
  preview_application_content jsonb;
  preview_application_record_content jsonb;
  installed_type jsonb;
  preview_type jsonb;
  installed_record_type jsonb;
  preview_record_type jsonb;
begin
  -- p_preview_installation must be the object read_current_preview_installation_internal returns
  -- for the validated human context: its organisation and Application scope the whole read.
  if p_preview_installation is null or not (p_preview_installation ? 'previewInstallationId') then
    return null;
  end if;
  organization_id_value := (p_preview_installation ->> 'organizationId')::uuid;
  application_root_id_value := (p_preview_installation ->> 'applicationRootId')::uuid;
  -- No active installation of the previewed Application (or none that binds the Module): nothing
  -- installed to read, so the preview is refused cleanly.
  begin
    active_installation := vortex_definition.read_active_installation_for_scope_internal(
      organization_id_value, application_root_id_value
    );
  exception
    when sqlstate 'P0002' then
      return null;
  end;
  select (item.value ->> 'moduleReleaseRevision')::bigint
  into installed_module_revision
  from pg_catalog.jsonb_array_elements(active_installation -> 'moduleBindings') as item(value)
  where pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  select (item.value ->> 'moduleReleaseRevision')::bigint
  into preview_module_revision
  from pg_catalog.jsonb_array_elements(p_preview_installation -> 'moduleBindings') as item(value)
  where pg_catalog.lower(item.value ->> 'moduleRootId') = p_module_root_id::text;
  installed_application_revision := (active_installation ->> 'applicationReleaseRevision')::bigint;
  preview_application_revision := (p_preview_installation ->> 'applicationReleaseRevision')::bigint;
  if installed_module_revision is null or preview_module_revision is null
    or installed_application_revision is null or preview_application_revision is null then
    return null;
  end if;

  -- The installed release is read from the stored releases only; the preview's is the rehearsed one.
  select release.compilation_output #> '{canonical,content}', release.record_content
  into installed_content, installed_record_content
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id and release.release_revision = installed_module_revision;
  if not found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  end if;
  select release.compilation_output #> '{canonical,content}', release.record_content
  into preview_content, preview_record_content
  from vortex_definition.runtime_releases as release
  where release.root_id = p_module_root_id and release.release_revision = preview_module_revision;
  if not found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  end if;
  select release.compilation_output #> '{canonical,content}', release.record_content
  into installed_application_content, installed_application_record_content
  from vortex_definition.releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = installed_application_revision;
  if not found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  end if;
  select release.compilation_output #> '{canonical,content}', release.record_content
  into preview_application_content, preview_application_record_content
  from vortex_definition.runtime_releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = preview_application_revision;
  if not found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  end if;

  select item.value into installed_type
  from pg_catalog.jsonb_array_elements(installed_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = p_record_type_id::text;
  select item.value into preview_type
  from pg_catalog.jsonb_array_elements(preview_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = p_record_type_id::text;
  select item.value into installed_record_type
  from pg_catalog.jsonb_array_elements(installed_record_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = p_record_type_id::text;
  select item.value into preview_record_type
  from pg_catalog.jsonb_array_elements(preview_record_content -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = p_record_type_id::text;

  -- The draft contributes only its query: its record type and the permissions that apply to the
  -- projection (the Module's and the Application's) must equal the installed release's.
  if installed_type is null or installed_type is distinct from preview_type
    or installed_record_type is null or installed_record_type is distinct from preview_record_type
    or vortex_record.record_type_permissions_internal(installed_content, p_record_type_id)
      is distinct from vortex_record.record_type_permissions_internal(preview_content, p_record_type_id)
    or vortex_record.record_type_permissions_internal(installed_record_content, p_record_type_id)
      is distinct from vortex_record.record_type_permissions_internal(preview_record_content, p_record_type_id)
    or vortex_record.record_type_permissions_internal(installed_application_content, p_record_type_id)
      is distinct from vortex_record.record_type_permissions_internal(preview_application_content, p_record_type_id)
    or vortex_record.record_type_permissions_internal(installed_application_record_content, p_record_type_id)
      is distinct from vortex_record.record_type_permissions_internal(preview_application_record_content, p_record_type_id) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'installation', active_installation,
    'moduleReleaseRevision', installed_module_revision,
    'recordType', installed_type,
    'recordContent', installed_record_content,
    'applicationRecordContent', installed_application_record_content
  );
end
$function$;

alter function vortex_record.read_installed_projection_internal(jsonb, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_installed_projection_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_installed_projection_internal(jsonb, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_record.read_installed_projection_internal(jsonb, uuid, uuid) is
  'Private: for a system projection read from a preview, the installed Module release''s record type and record content when the preview''s record type and the permissions that apply to it (the Module''s and the Application''s) equal the installed ones, else null; null too when the previewed Application has no active installation that binds the Module or the preview object has no previewInstallationId; a missing release row raises 55000. The preview object must come from read_current_preview_installation_internal.';
