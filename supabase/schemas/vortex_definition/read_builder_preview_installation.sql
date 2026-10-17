create or replace function vortex_definition.read_builder_preview_installation(
  p_application_root_id uuid
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
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  -- A builder has at most one preview of an Application; the newest is the current one. A
  -- preview whose provisioning stopped before it wrote the release set it runs never runs, so it
  -- is not a current preview: the next request provisions one that replaces it.
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at,
    'seeded', preview.seeded_at is not null
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  where preview.application_root_id = p_application_root_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and preview.runtime_release_set is not null
    and root.kind = 'application'
    and root.organization_id = preview.organization_id
  order by preview.created_at desc, preview.preview_installation_id desc
  limit 1;
  return identity_value;
end
$function$;

alter function vortex_definition.read_builder_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_builder_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_builder_preview_installation(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_preview_installation(uuid) is
  'The current unexpired preview of one Application that the builder of the validated human organisation context opened, with its draft revision and whether it holds copied live records; null when they have none. Studio reads the canvas and Data tab records through it.';
