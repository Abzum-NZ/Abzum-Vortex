create or replace function vortex_definition.read_preview_application_identity(
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
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and root.kind = 'application';
  return identity_value;
end
$function$;

alter function vortex_definition.read_preview_application_identity(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_application_identity(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_application_identity(uuid)
  to vortex_request;
comment on function vortex_definition.read_preview_application_identity(uuid) is
  'The Application, key and draft revision of one unexpired preview, for a builder of the validated human organisation context; null when there is no such preview.';
