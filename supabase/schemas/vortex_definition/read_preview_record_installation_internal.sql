create or replace function vortex_definition.read_preview_record_installation_internal(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  module_bindings_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    return null;
  end if;

  begin
    context_value := vortex_definition.assert_preview_installation_authority_internal();
  exception when insufficient_privilege then
    return null;
  end;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for key share;
  if not found then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', preview_row.organization_id,
      'applicationRootId', preview_row.application_root_id,
      'moduleRootId', item.value -> 'moduleRootId',
      'bindingRevision', 1,
      'applicationReleaseRevision', preview_row.application_release_revision,
      'moduleReleaseRevision', item.value -> 'moduleReleaseRevision',
      'state', 'active'
    ) order by item.value ->> 'moduleRootId' collate "C"
  ), '[]'::jsonb)
  into module_bindings_value
  from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value);

  return pg_catalog.jsonb_build_object(
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'applicationReleaseRevision', preview_row.application_release_revision,
    'moduleBindings', module_bindings_value,
    'previewInstallationId', preview_row.preview_installation_id,
    'storageIdentities', preview_row.storage_identities
  );
end
$function$;

alter function vortex_definition.read_preview_record_installation_internal(uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.read_preview_record_installation_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_preview_record_installation_internal(uuid)
  to vortex_record_adapter, vortex_owner;
comment on function vortex_definition.read_preview_record_installation_internal(uuid) is
  'The installation of one unexpired preview for a builder of its Application in the validated human request: the active installation shape with the preview''s exact release pins, its address and its isolated storage identities.';
