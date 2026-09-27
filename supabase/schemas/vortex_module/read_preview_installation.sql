create or replace function vortex_module.read_preview_installation(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_module.preview_installations%rowtype;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_module.assert_preview_installation_authority_internal();
  select preview.* into preview_row
  from vortex_module.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_identity_id = (checked_context ->> 'identityId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp();
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_row.preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'draftRevision', preview_row.draft_revision,
    'previewerIdentityId', preview_row.previewer_identity_id,
    'previewerOrganizationAccountId', preview_row.previewer_organization_account_id,
    'candidate', preview_row.candidate,
    'resolvedModules', preview_row.resolved_modules,
    'storageIdentities', preview_row.storage_identities,
    'createdAt', preview_row.created_at,
    'expiresAt', preview_row.expires_at
  );
end
$function$;

revoke all on function vortex_module.read_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_module.read_preview_installation(uuid)
  to vortex_request;
comment on function vortex_module.read_preview_installation(uuid) is
  'Reads a non-expired preview installation only for its creating organisation account in the validated human request.';
