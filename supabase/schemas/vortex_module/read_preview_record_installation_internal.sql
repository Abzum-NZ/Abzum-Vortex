create or replace function vortex_module.read_preview_record_installation_internal(
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
  preview_row vortex_module.preview_installations%rowtype;
  module_bindings_value jsonb;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text) then
    return null;
  end if;

  begin
    context_value := vortex_module.assert_preview_installation_authority_internal();
  exception when insufficient_privilege then
    return null;
  end;
  select preview.* into preview_row
  from vortex_module.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.previewer_identity_id = (context_value ->> 'identityId')::uuid
    and preview.previewer_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for key share;
  if not found then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'moduleRootId', item.value -> 'moduleRootId',
      'moduleReleaseRevision', item.value -> 'moduleReleaseRevision',
      'bindingRevision', 1,
      'state', 'active'
    ) order by item.value ->> 'moduleRootId' collate "C"
  ), '[]'::jsonb)
  into module_bindings_value
  from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_row.preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'applicationReleaseRevision', preview_row.draft_revision,
    'moduleBindings', module_bindings_value,
    'candidate', preview_row.candidate,
    'resolvedModules', preview_row.resolved_modules,
    'storageIdentities', preview_row.storage_identities
  );
end
$function$;

alter function vortex_module.read_preview_record_installation_internal(uuid)
  owner to vortex_module_owner;

revoke all on function vortex_module.read_preview_record_installation_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_module.read_preview_record_installation_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_module.read_preview_record_installation_internal(uuid) is
  'Private owner-only preview installation reader for the protected Record port, restricted to the exact human identity, organisation account and Application context until expiry.';
