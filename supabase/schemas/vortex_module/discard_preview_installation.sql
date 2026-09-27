create or replace function vortex_module.discard_preview_installation(
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
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Preview installation is unavailable';
  end if;
  perform vortex_record.drop_preview_installation_storage(
    preview_row.preview_installation_id
  );
  delete from vortex_module.preview_installations as preview
  where preview.preview_installation_id = preview_row.preview_installation_id;
  return pg_catalog.jsonb_build_object(
    'discarded', true,
    'previewInstallationId', preview_row.preview_installation_id
  );
end
$function$;

revoke all on function vortex_module.discard_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_module.discard_preview_installation(uuid)
  to vortex_request;
comment on function vortex_module.discard_preview_installation(uuid) is
  'Immediately drops a preview installation and its isolated Record storage, only for the creating organisation account.';
