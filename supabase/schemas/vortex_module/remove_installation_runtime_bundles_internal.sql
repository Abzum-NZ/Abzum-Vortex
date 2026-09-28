create or replace function vortex_module.remove_installation_runtime_bundles_internal(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  bundle_list jsonb;
  bundles_removed bigint;
  bundle_parts_removed bigint;
  access_plans_removed bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Runtime bundle uninstall command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  perform 1
  from vortex_module.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
  order by binding.module_root_id
  for update;

  if exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state in ('active', 'draining')
  ) then
    raise exception using errcode = '40001',
      message = 'Runtime bundles cannot be removed before installation drain completes';
  end if;

  delete from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = authority.organization_id
    and part.application_root_id = p_application_root_id;
  get diagnostics bundle_parts_removed = row_count;

  with removed_bundles as (
    delete from vortex_module.installation_runtime_bundles as bundle
    where bundle.organization_id = authority.organization_id
      and bundle.application_root_id = p_application_root_id
    returning bundle.application_release_revision, bundle.bundle_format_version
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationReleaseRevision', removed.application_release_revision,
          'bundleFormatVersion', removed.bundle_format_version
        ) order by removed.application_release_revision, removed.bundle_format_version
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)
  into bundle_list, bundles_removed
  from removed_bundles as removed;

  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = authority.organization_id
    and plan.application_root_id = p_application_root_id;
  get diagnostics access_plans_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'bundles', bundle_list,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed
  );
end
$function$;

alter function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  to vortex_request;
comment on function vortex_module.remove_installation_runtime_bundles_internal(uuid) is
  'Lists and removes all runtime bundle registrations and access plans for one authorised installation after its bindings are detached.';
