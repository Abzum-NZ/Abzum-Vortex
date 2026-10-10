begin;

set local role vortex_module_owner;

create or replace function vortex_module.read_provisioned_lifecycle_setup_targets_internal(
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
  initial_authority record;
  current_authority record;
  initial_context jsonb;
  current_context jsonb;
  completion_time timestamptz;
  context_expires_at timestamptz;
  delegated_expires_at timestamptz;
  application_definition_key text;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_module.installation_bindings%rowtype;
  storage_provision record;
  expected_module_root_id uuid;
  expected_binding_revision bigint;
  previous_module_root_id uuid;
  module_root_text text;
  binding_revision_text text;
  closure_count bigint;
  expected_count integer;
  module_bindings jsonb := '[]'::jsonb;
  normalized_pins jsonb;
  all_storage_contract_ids uuid[] := array[]::uuid[];
  union_storage_contract_ids uuid[];
  storage_contract_id_count bigint;
  distinct_storage_contract_id_count bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
  end if;

  if p_expected_module_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if expected_count < 1 or expected_count > 10000 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  previous_module_root_id := null;
  for pin in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
  loop
    if pg_catalog.jsonb_typeof(pin.value) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if not (pin.value ?& array['moduleRootId', 'bindingRevision'])
      or pin.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(pin.value)) <> 2 then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if pg_catalog.jsonb_typeof(pin.value -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(pin.value -> 'bindingRevision') is distinct from 'number' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    module_root_text := pin.value ->> 'moduleRootId';
    if module_root_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not pg_catalog.pg_input_is_valid(module_root_text, 'uuid') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_module_root_id := module_root_text::uuid;
    if expected_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or module_root_text is distinct from expected_module_root_id::text then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    binding_revision_text := pin.value ->> 'bindingRevision';
    if binding_revision_text !~ '^[1-9][0-9]*$'
      or not pg_catalog.pg_input_is_valid(binding_revision_text, 'bigint') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_binding_revision := binding_revision_text::bigint;
    if expected_binding_revision not between 1 and 9007199254740991
      or (previous_module_root_id is not null
        and previous_module_root_id >= expected_module_root_id) then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    previous_module_root_id := expected_module_root_id;
  end loop;

  select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', (item.value ->> 'moduleRootId')::uuid,
        'bindingRevision', (item.value ->> 'bindingRevision')::bigint
      )
      order by (item.value ->> 'moduleRootId')::uuid
    )
  into strict normalized_pins
  from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value);
  if p_expected_module_bindings is distinct from normalized_pins then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;
  initial_context := vortex_access.validated_human_request_context();
  if initial_context ->> 'callerKind' is distinct from 'human'
    or (initial_context ->> 'organizationId')::uuid is distinct from initial_authority.organization_id
    or (initial_context ->> 'organizationAccountId')::uuid is distinct from initial_authority.organization_account_id
    or (initial_context ->> 'accessVersion')::bigint is distinct from initial_authority.access_version
    or (initial_context ->> 'correlationId')::uuid is distinct from initial_authority.correlation_id
    or (initial_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Provisioned Application lifecycle setup authority is unavailable';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision;

  select root.key into strict application_definition_key
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application';

  if not application_release.validation_contract_version = any (
      vortex_definition.accepted_contract_version('application')
    )
    or application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from application_release.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact Application release is unavailable';
  end if;

  select snapshot.* into strict permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if permission_snapshot.organization_id is distinct from initial_authority.organization_id
    or permission_snapshot.application_root_id is distinct from p_application_root_id
    or permission_snapshot.registration_revision not between 1 and 9007199254740991
    or permission_snapshot.release_revision is distinct from p_application_release_revision
    or permission_snapshot.definition_key is distinct from application_definition_key
    or permission_snapshot.release_version is distinct from application_release.release_version
    or permission_snapshot.validation_contract_version is distinct from application_release.validation_contract_version
    or permission_snapshot.content_fingerprint is distinct from application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint is distinct from application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  select pg_catalog.count(*) into closure_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  if closure_count < 1
    or closure_count > 10000
    or closure_count <> expected_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.target_root_id
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
  end loop;

  for pin in
    select required.target_root_id
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for share;
  end loop;

  for locked_binding in
    select binding.*
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
    order by binding.module_root_id
    for share
  loop
    if locked_binding.state <> 'detached'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          p_application_root_id, p_application_release_revision
        ) as required
        where required.target_root_id = locked_binding.module_root_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;
  end loop;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select (expected.value ->> 'bindingRevision')::bigint
    into strict expected_binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = pin.target_root_id;

    select binding.* into strict locked_binding
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    if locked_binding.binding_revision is distinct from expected_binding_revision
      or locked_binding.application_release_revision is distinct from p_application_release_revision
      or locked_binding.module_release_revision is distinct from pin.target_release_revision
      or locked_binding.state is distinct from 'provisioned'
      or locked_binding.content_fingerprint is distinct from pin.dependency_content_fingerprint
      or locked_binding.resolution_fingerprint is distinct from pin.evidence_fingerprint
      or locked_binding.generator_contract_version is distinct from '1.0.0' then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;
    if storage_provision.module_root_id is distinct from pin.target_root_id
      or storage_provision.release_revision is distinct from pin.target_release_revision
      or storage_provision.storage_contract_ids is null
      or (
        pg_catalog.cardinality(storage_provision.storage_contract_ids) > 0
        and (
          pg_catalog.array_ndims(storage_provision.storage_contract_ids) is distinct from 1
          or pg_catalog.array_lower(storage_provision.storage_contract_ids, 1) is distinct from 1
        )
      )
      or locked_binding.storage_contract_ids is distinct from storage_provision.storage_contract_ids
      or exists (
        select 1
        from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
        where stored.contract_id is null
          or stored.contract_id = '00000000-0000-0000-0000-000000000000'::uuid
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;

    select pg_catalog.count(*),
      pg_catalog.count(distinct stored.contract_id)
    into storage_contract_id_count, distinct_storage_contract_id_count
    from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id);
    if storage_contract_id_count <> distinct_storage_contract_id_count then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence is invalid';
    end if;

    all_storage_contract_ids := all_storage_contract_ids || storage_provision.storage_contract_ids;
    module_bindings := module_bindings || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', pin.target_root_id,
        'moduleReleaseRevision', pin.target_release_revision,
        'bindingRevision', locked_binding.binding_revision,
        'state', 'provisioned',
        'storageContractIds', pg_catalog.to_jsonb(storage_provision.storage_contract_ids)
      )
    );
  end loop;

  select coalesce(
      pg_catalog.array_agg(distinct stored.contract_id order by stored.contract_id),
      array[]::uuid[]
    )
  into union_storage_contract_ids
  from pg_catalog.unnest(all_storage_contract_ids) as stored(contract_id);

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  current_context := vortex_access.validated_human_request_context();
  if current_authority.organization_id is distinct from initial_authority.organization_id
    or current_authority.organization_account_id is distinct from initial_authority.organization_account_id
    or current_authority.access_version is distinct from initial_authority.access_version
    or current_authority.correlation_id is distinct from initial_authority.correlation_id
    or current_context is distinct from initial_context
    or current_context ->> 'callerKind' is distinct from 'human'
    or (current_context ->> 'organizationId')::uuid is distinct from current_authority.organization_id
    or (current_context ->> 'organizationAccountId')::uuid is distinct from current_authority.organization_account_id
    or (current_context ->> 'accessVersion')::bigint is distinct from current_authority.access_version
    or (current_context ->> 'correlationId')::uuid is distinct from current_authority.correlation_id
    or (current_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  completion_time := pg_catalog.clock_timestamp();
  context_expires_at := (current_context ->> 'expiresAt')::timestamptz;
  if not pg_catalog.isfinite(context_expires_at)
    or context_expires_at <= completion_time then
    raise exception using errcode = '42501',
      message = 'Application installation context expired';
  end if;
  if current_context ? 'delegatedContext' then
    delegated_expires_at := (current_context #>> '{delegatedContext,expiresAt}')::timestamptz;
    if not pg_catalog.isfinite(delegated_expires_at)
      or delegated_expires_at <= completion_time then
      raise exception using errcode = '42501',
        message = 'Application installation delegation expired';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'registrationRevision', permission_snapshot.registration_revision,
    'moduleBindings', module_bindings,
    'storageContractIds', pg_catalog.to_jsonb(union_storage_contract_ids)
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application lifecycle setup evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application lifecycle setup evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
end
$function$;

alter function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid,bigint,jsonb)
  owner to vortex_module_owner;

revoke all on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_access_owner, vortex_definition_owner,
    vortex_invalidation_owner;
grant execute on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  to vortex_record_owner;
comment on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb) is
  'Module-owned complete exact provisioned lifecycle setup targets for the authorized Record setup reader.';

reset role;

commit;
