create or replace function vortex_definition.refresh_preview_installation(
  p_preview_installation_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  expires_at_value timestamptz;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_releases #>> '{application,draftRevision}' is distinct from p_expected_draft_revision::text
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- A preview follows its draft in its own request: its builder, its Application, its address.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or vortex_definition.current_preview_installation_id_internal()
      is distinct from p_preview_installation_id then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  -- Reads of the preview (for key share) go on while it moves; a second move waits.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  select draft.draft_revision into draft_revision_value
  from vortex_definition.drafts as draft
  where draft.root_id = preview_row.application_root_id
;
  -- A preview only moves forward, to the current draft revision.
  if not found or draft_revision_value <> p_expected_draft_revision
    or p_expected_draft_revision < preview_row.draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    preview_row.organization_id, preview_row.application_root_id, p_releases
  );

  delete from vortex_definition.preview_releases as release
  where release.preview_installation_id = p_preview_installation_id;
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select p_preview_installation_id, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases -> 'releases') as item(value);
  -- Its registration is written again from the new releases and draft roles.
  delete from vortex_access.preview_permission_entries as entry
  where entry.preview_installation_id = p_preview_installation_id;
  delete from vortex_access.preview_permission_registrations as registration
  where registration.preview_installation_id = p_preview_installation_id;
  expires_at_value := pg_catalog.statement_timestamp() + preview_lifetime;
  -- The release set it runs is written again, in this same request, after the new pins.
  update vortex_definition.preview_installations as preview
  set draft_revision = p_expected_draft_revision,
      application_release_revision = application_release_revision_value,
      draft_shape_fingerprint = p_shape_fingerprint,
      runtime_release_set = null,
      expires_at = expires_at_value
  where preview.preview_installation_id = p_preview_installation_id;
  perform vortex_definition.write_preview_shape_internal(p_preview_installation_id, true);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', p_preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', preview_row.created_at,
    'expiresAt', expires_at_value
  );
end
$function$;

alter function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) is
  'Moves the builder''s preview, in its own request, to the current draft revision in place: the server-compiled release plan, the Module pins, its permission registration and its Record storage, keeping the records it holds, and another 24 hours. Its release set is written again in the same request. A change the stored records cannot take raises V3201.';
