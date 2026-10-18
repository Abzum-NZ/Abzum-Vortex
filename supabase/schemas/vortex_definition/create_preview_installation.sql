create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
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
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  -- A preview is provisioned in the organisation's context: the Application it previews may have
  -- no installation, and so no Application context, yet.
  if checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision
  into draft_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    organization_id_value, p_application_root_id, p_releases
  );

  -- One preview per Application and builder: a new preview replaces this builder's previous one
  -- and its storage, never another builder's.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
      and preview.previewer_organization_account_id = organization_account_id_value
    order by preview.preview_installation_id
    for update
  loop
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at, draft_shape_fingerprint
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value, p_shape_fingerprint
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);
  perform vortex_definition.write_preview_shape_internal(preview_installation_id_value, false);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    -- The builder's live records reach the preview only through the installed Application.
    'seedable', exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = organization_id_value
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    )
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) is
  'Replaces the builder''s 24-hour preview of one Application with a preview of its current draft: the releases its publication rehearsed, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, empty isolated storage for every bound record type, and the fingerprint of the draft''s data shape.';
