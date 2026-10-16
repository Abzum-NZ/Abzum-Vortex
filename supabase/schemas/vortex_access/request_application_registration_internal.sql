create or replace function vortex_access.request_application_registration_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_organization_account_id uuid
)
returns table (
  registration_kind text,
  preview_installation_id uuid,
  source_revision bigint,
  owned_owner_ids uuid[],
  role_ids uuid[],
  valid_until timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  preview_address text;
begin
  -- The one place that says which permission registration a request to an Application runs
  -- under. A request without a preview address runs the active installed registration. A request
  -- with one runs only that preview's registration, which exists for the builder who opened the
  -- preview, and never falls back to the installed registration.
  if not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text) then
    return;
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is null then
    return query
    select 'installed'::text, null::uuid, registration.source_revision, null::uuid[],
      null::uuid[], null::timestamptz
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active';
    return;
  end if;
  if not pg_catalog.pg_input_is_valid(preview_address, 'uuid') then
    return;
  end if;
  return query
  select 'preview'::text, preview.preview_installation_id,
    preview.application_release_revision, registration.owned_owner_ids,
    registration.role_ids, preview.expires_at
  from vortex_access.preview_permission_registrations as registration
  join vortex_definition.preview_installations as preview
    on preview.preview_installation_id = registration.preview_installation_id
  where registration.preview_installation_id = preview_address::uuid
    and registration.organization_id = p_organization_id
    and registration.application_root_id = p_application_root_id
    and registration.organization_account_id = p_organization_account_id
    and preview.organization_id = p_organization_id
    and preview.application_root_id = p_application_root_id
    and preview.previewer_organization_account_id = p_organization_account_id
    and preview.expires_at > pg_catalog.statement_timestamp();
end
$function$;

alter function vortex_access.request_application_registration_internal(uuid, uuid, uuid)
  owner to vortex_owner;

revoke all on function vortex_access.request_application_registration_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

comment on function vortex_access.request_application_registration_internal(uuid, uuid, uuid) is
  'The permission registration one organisation account''s request to an Application runs under: the active installed registration, or, for a request with a preview address, only the registration of that unexpired preview, which only the builder who opened it holds.';
