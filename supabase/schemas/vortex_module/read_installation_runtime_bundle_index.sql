create or replace function vortex_module.read_installation_runtime_bundle_index(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_organization_id uuid;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2 then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle key is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Installation runtime bundle organisation is unavailable';
  end if;

  select stored.* into stored_bundle
  from vortex_module.installation_runtime_bundles as stored
  where stored.organization_id = selected_organization_id
    and stored.application_root_id = p_application_root_id
    and stored.application_release_revision = p_application_release_revision
    and stored.bundle_format_version = p_bundle_format_version;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
end
$function$;

alter function vortex_module.read_installation_runtime_bundle_index(uuid,bigint,integer) owner to vortex_module_owner;

revoke all on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) to vortex_request;
comment on function vortex_module.read_installation_runtime_bundle_index(
  uuid, bigint, integer
) is
  'Reads one exact immutable runtime bundle index inside the verified organisation context.';
