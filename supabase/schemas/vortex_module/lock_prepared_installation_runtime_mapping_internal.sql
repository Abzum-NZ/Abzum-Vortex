create or replace function vortex_module.lock_prepared_installation_runtime_mapping_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  initial_authority record;
  current_authority record;
  registration_revision bigint;
  required_count integer;
  expected_count integer;
  binding_item jsonb;
  pin_facts jsonb;
  binding_facts jsonb;
  pin_fingerprint text;
begin
  if p_application_root_id is null or p_application_root_id = none_uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
        or item.value - array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId') !~* '^[0-9a-f-]{36}$'
        or (item.value ->> 'moduleReleaseRevision') !~ '^[1-9][0-9]*$'
        or (item.value ->> 'bindingRevision') !~ '^[1-9][0-9]*$'
        or item.value ->> 'state' is distinct from 'provisioned'
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
      message = 'Prepared installation mapping command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select snapshot.release_revision into registration_revision
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if registration_revision is distinct from p_application_release_revision then
    raise exception using errcode = '42501',
      message = 'Prepared installation registration is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = initial_authority.organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Prepared installation Application release is unavailable';
  end if;

  select pg_catalog.count(*)::integer into required_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if required_count = 0 or expected_count <> required_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
          and (expected.value ->> 'moduleReleaseRevision')::bigint = required.target_release_revision
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Prepared installation pin set is incomplete';
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    order by (item.value ->> 'moduleRootId')::uuid
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || (binding_item ->> 'moduleRootId'),
        0
      )
    );
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = (binding_item ->> 'moduleRootId')::uuid
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Prepared installation authority changed';
  end if;

  if exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          p_application_root_id, p_application_release_revision
        ) as required
        where required.target_root_id = binding.module_root_id
      )
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
    left join lateral (
      select (expected.value ->> 'bindingRevision')::bigint as binding_revision
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
      where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
        and (expected.value ->> 'moduleReleaseRevision')::bigint = required.target_release_revision
    ) as expected on true
    where binding.state is distinct from 'provisioned'
      or binding.application_release_revision is distinct from p_application_release_revision
      or binding.module_release_revision is distinct from required.target_release_revision
      or binding.binding_revision is distinct from expected.binding_revision
  ) then
    raise exception using errcode = '40001',
      message = 'Prepared installation binding set changed';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', pin.target_root_id,
      'moduleReleaseRevision', pin.target_release_revision,
      'contentFingerprint', release.content_fingerprint,
      'resolutionFingerprint', release.resolution_fingerprint
    ) order by pin.target_root_id)
  into pin_facts
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as pin
  join vortex_definition.releases as release
    on release.root_id = pin.target_root_id
    and release.release_revision = pin.target_release_revision;
  if pin_facts is null or pg_catalog.jsonb_array_length(pin_facts) <> required_count then
    raise exception using errcode = '55000',
      message = 'Prepared installation source pins are unavailable';
  end if;
  pin_fingerprint := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text, 'UTF8')),
    'hex'
  );

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id)
  into binding_facts
  from vortex_module.installation_bindings as binding
  where binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  if binding_facts is distinct from p_expected_module_bindings then
    raise exception using errcode = '40001',
      message = 'Prepared installation expected bindings changed';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'organizationAccountId', initial_authority.organization_account_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'accessVersion', initial_authority.access_version,
    'correlationId', initial_authority.correlation_id,
    'registeredReleaseRevision', registration_revision,
    'pinFingerprint', pin_fingerprint,
    'pinFacts', pin_facts,
    'moduleBindings', binding_facts
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared installation mapping evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared installation mapping evidence is ambiguous';
end
$function$;

alter function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  owner to vortex_module_owner;
revoke all on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
grant execute on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb)
  to vortex_record_adapter;
comment on function vortex_module.lock_prepared_installation_runtime_mapping_internal(uuid,bigint,jsonb) is
  'Locks the current human installation authority and exact complete provisioned Module pin mapping for first-install runtime preparation.';
