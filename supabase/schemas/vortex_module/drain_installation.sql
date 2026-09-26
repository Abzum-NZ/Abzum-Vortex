create or replace function vortex_module.drain_installation(
  p_activity_id uuid,
  p_root_id uuid,
  p_release_revision bigint,
  p_expected_module_bindings jsonb
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
  target_kind text;
  application_release vortex_definition.releases%rowtype;
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_draining boolean;
  changed_value boolean;
  binding_evidence jsonb;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select root.kind into target_kind
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  -- A Module is never installed on its own; its storage and records exist because an
  -- installed Application binds that exact release. Uninstalling a Module an installed
  -- Application still depends on is refused.
  if target_kind = 'module' then
    if exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.module_root_id = p_root_id
        and binding.state in ('provisioned', 'active', 'draining')
    ) then
      raise exception using errcode = '42501',
        message = 'Installation is required by an installed application';
    end if;
    raise exception using errcode = 'P0002',
      message = 'Installation is unavailable';
  end if;

  -- The organisation's access-management application is the steward's working way to
  -- manage access. Any uninstall step that would remove it is refused.
  if vortex_access.application_is_stewardship_management_application(
    initial_authority.organization_id, p_root_id
  ) then
    raise exception using errcode = '42501',
      message = 'Installation is required for access management';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision);
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'draining'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_active, all_draining
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  left join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true;
  if all_active is null or (not all_active and not all_draining)
    or exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1
          from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Installation bindings changed or are incomplete';
  end if;

  changed_value := all_active;
  if changed_value then
    if exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
      join vortex_module.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Installation binding revision is exhausted';
    end if;
    update vortex_module.installation_bindings as binding
    set state = 'draining', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation bindings changed';
    end if;
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(p_root_id, p_release_revision) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_root_id
    and binding.module_root_id = required.target_root_id;

  if changed_value then
    perform vortex_module.append_application_installation_activity_internal(
      p_activity_id, p_root_id, 'drain_application_installation'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_root_id,
    'applicationReleaseRevision', p_release_revision,
    'state', 'draining', 'changed', changed_value,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Installation drain command is invalid';
end
$function$;

revoke all on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.drain_installation(uuid, uuid, bigint, jsonb) is
  'Protected first uninstall step: moves one exact active Application installation to draining, or refuses a Module an installed Application depends on or the organisation access-management Application, recording Activity from the trusted channel.';
