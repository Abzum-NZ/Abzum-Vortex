create or replace function vortex_module.discard_prepared_application_installation(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  pin record;
  expected_pin_count integer;
  staged_binding_count integer;
  provisioned_binding_count integer;
  removed_bindings jsonb := '[]'::jsonb;
  removed_count integer := 0;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Application installation discard command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = p_application_root_id
      and root.organization_id = initial_authority.organization_id
      and root.kind = 'application'
      and release.release_revision = p_application_release_revision
      and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'))
  ) then
    raise exception using errcode = 'P0002',
      message = 'Exact Application release is unavailable';
  end if;

  select pg_catalog.count(*)::integer into expected_pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  if expected_pin_count = 0 then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
    perform 1
    from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = initial_authority.organization_id
      and staged.application_root_id = p_application_root_id
      and staged.application_release_revision = p_application_release_revision
      and staged.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  if exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.application_release_revision = p_application_release_revision
      and binding.state in ('active', 'draining')
  ) then
    raise exception using errcode = '40001',
      message = 'An active Application installation cannot be discarded';
  end if;

  select pg_catalog.count(*)::integer into staged_binding_count
  from vortex_module.staged_installation_bindings as staged
  where staged.organization_id = initial_authority.organization_id
    and staged.application_root_id = p_application_root_id
    and staged.application_release_revision = p_application_release_revision;

  select pg_catalog.count(*)::integer into provisioned_binding_count
  from vortex_module.installation_bindings as binding
  where binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.application_release_revision = p_application_release_revision
    and binding.state = 'provisioned';

  if staged_binding_count > 0 and provisioned_binding_count > 0 then
    raise exception using errcode = '55000',
      message = 'Application installation candidate evidence is ambiguous';
  end if;

  -- Provisioning can commit individual pins before a candidate is abandoned.
  -- Remove any matching subset; completeness is required only for activation.
  if staged_binding_count > 0 then
    if exists (
      select 1
      from vortex_module.staged_installation_bindings as staged
      where staged.organization_id = initial_authority.organization_id
        and staged.application_root_id = p_application_root_id
        and staged.application_release_revision = p_application_release_revision
        and not exists (
          select 1
          from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = staged.module_root_id
            and required.target_release_revision = staged.module_release_revision
        )
    ) then
      raise exception using errcode = '40001',
        message = 'Staged Application installation bindings do not match the release';
    end if;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', staged.organization_id,
        'applicationRootId', staged.application_root_id,
        'moduleRootId', staged.module_root_id,
        'bindingRevision', staged.binding_revision,
        'applicationReleaseRevision', staged.application_release_revision,
        'moduleReleaseRevision', staged.module_release_revision,
        'state', 'provisioned'
      ) order by staged.module_root_id), '[]'::jsonb)
    into removed_bindings
    from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = initial_authority.organization_id
      and staged.application_root_id = p_application_root_id
      and staged.application_release_revision = p_application_release_revision;

    delete from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = initial_authority.organization_id
      and staged.application_root_id = p_application_root_id
      and staged.application_release_revision = p_application_release_revision;
    get diagnostics removed_count = row_count;
  elsif provisioned_binding_count > 0 then
    if exists (
      select 1
      from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.application_release_revision = p_application_release_revision
        and binding.state = 'provisioned'
        and not exists (
          select 1
          from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
            and required.target_release_revision = binding.module_release_revision
        )
    ) then
      raise exception using errcode = '40001',
        message = 'Prepared Application installation bindings do not match the release';
    end if;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', binding.organization_id,
        'applicationRootId', binding.application_root_id,
        'moduleRootId', binding.module_root_id,
        'bindingRevision', binding.binding_revision,
        'applicationReleaseRevision', binding.application_release_revision,
        'moduleReleaseRevision', binding.module_release_revision,
        'state', binding.state
      ) order by binding.module_root_id), '[]'::jsonb)
    into removed_bindings
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.application_release_revision = p_application_release_revision
      and binding.state = 'provisioned';

    delete from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.application_release_revision = p_application_release_revision
      and binding.state = 'provisioned';
    get diagnostics removed_count = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'changed', removed_count > 0,
    'moduleBindings', removed_bindings
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation discard command is invalid';
end
$function$;

alter function vortex_module.discard_prepared_application_installation(uuid,bigint) owner to vortex_module_owner;

revoke all on function vortex_module.discard_prepared_application_installation(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.discard_prepared_application_installation(uuid, bigint)
  to vortex_request;
comment on function vortex_module.discard_prepared_application_installation(uuid, bigint) is
  'Protected removal of one exact inactive staged or provisioned Application candidate while retaining shared Module storage mappings and records.';
