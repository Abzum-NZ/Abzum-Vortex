-- #993: check accepted definition contract versions in one helper.
--
-- Removes the literal definition validation contract-version strings from the
-- provisioning, installation, storage-conversion and record-access-fact functions,
-- which used to drift from the TypeScript contracts (see #830). Each definition now
-- reads the one accepted set from vortex_definition.accepted_contract_version(kind),
-- so a contract-version bump changes a single SQL line. Only the version comparison
-- changes; every body is the function's complete live definition, including the
-- in-place relationship-target and index-readiness patches applied after its last
-- create, and its owner, security definer, search_path, grants and comment are kept.

create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['2.0.0'];
    when 'module' then
      return array['2.0.0', '3.0.0'];
    when 'module_storage_conversion' then
      return array['2.0.0'];
    when 'record_type' then
      return array['1.0.0', '2.0.0', '3.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

revoke all on function vortex_definition.accepted_contract_version(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_module_owner, vortex_record_owner;
comment on function vortex_definition.accepted_contract_version(text) is
  'One accepted definition contract-version set per contract kind. application: vortex_module.provision_module_installation_storage and vortex_module.activate/detach_application_installation. module: vortex_record.provision_exact_module_storage. module_storage_conversion: vortex_record.register_storage_conversion_plan. record_type: vortex_access.evaluate_organization_record_access_internal.';

set local role vortex_module_owner;
create or replace function vortex_module.provision_module_installation_storage(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_expected_binding_revision bigint
)
returns table (
  state text,
  changed boolean,
  binding_revision bigint,
  application_root_id uuid,
  application_release_revision bigint,
  module_root_id uuid,
  module_release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  application_release vortex_definition.releases%rowtype;
  stored_binding vortex_module.installation_bindings%rowtype;
  provision record;
  next_binding_revision bigint;
  binding_exists boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_expected_binding_revision is not null
      and p_expected_binding_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Module installation storage command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001', message = 'Module installation context changed';
  end if;

  -- The binding identity is locked before its row can exist. Storage lineage
  -- locks are acquired later by the Record helper in canonical UUID order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || permission_decision.organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_application_root_id
    and release.release_revision = p_application_release_revision
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;
  if application_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('application'))
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('application')) then
    raise exception using errcode = '23514', message = 'Exact Application release is unavailable';
  end if;
  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as edge
    where edge.target_root_id = p_module_root_id
      and edge.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514', message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_module.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  binding_exists := found;

  if binding_exists then
    if stored_binding.state = 'active'
      or (
        p_expected_binding_revision is null
        and (
          stored_binding.application_release_revision <> p_application_release_revision
          or stored_binding.module_release_revision <> p_module_release_revision
          or stored_binding.state <> 'provisioned'
        )
      )
      or (
        p_expected_binding_revision is not null
        and stored_binding.binding_revision <> p_expected_binding_revision
      ) then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  end if;
  if not binding_exists and p_expected_binding_revision is not null then
    raise exception using errcode = '40001', message = 'Module installation binding is unavailable';
  end if;

  select storage.* into strict provision
  from vortex_record.provision_exact_module_storage(
    p_module_root_id, p_module_release_revision
  ) as storage;

  if binding_exists
    and stored_binding.application_release_revision = p_application_release_revision
    and stored_binding.module_release_revision = p_module_release_revision
    and stored_binding.state = 'provisioned' then
    if stored_binding.content_fingerprint <> provision.content_fingerprint
      or stored_binding.resolution_fingerprint <> provision.resolution_fingerprint
      or stored_binding.generator_contract_version <> provision.generator_contract_version
      or stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.content_fingerprint, stored_binding.resolution_fingerprint,
      stored_binding.generator_contract_version, stored_binding.storage_contract_ids;
    return;
  end if;

  if binding_exists then
    if stored_binding.binding_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := stored_binding.binding_revision + 1;
    update vortex_module.installation_bindings as binding
    set binding_revision = next_binding_revision,
        application_release_revision = p_application_release_revision,
        module_release_revision = p_module_release_revision,
        state = 'provisioned',
        content_fingerprint = provision.content_fingerprint,
        resolution_fingerprint = provision.resolution_fingerprint,
        generator_contract_version = provision.generator_contract_version,
        storage_contract_ids = provision.storage_contract_ids,
        changed_at = pg_catalog.statement_timestamp()
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = p_module_root_id
      and binding.binding_revision = p_expected_binding_revision;
    if not found then
      raise exception using errcode = '40001', message = 'Module installation binding changed';
    end if;
  else
    next_binding_revision := 1;
    insert into vortex_module.installation_bindings (
      organization_id, application_root_id, module_root_id, binding_revision,
      application_release_revision, module_release_revision, state,
      content_fingerprint, resolution_fingerprint, generator_contract_version,
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.content_fingerprint, provision.resolution_fingerprint,
      provision.generator_contract_version, provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.content_fingerprint,
    provision.resolution_fingerprint, provision.generator_contract_version,
    provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

revoke all on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits only an inactive Module binding.';

create or replace function vortex_module.activate_application_installation(
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
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_module.installation_bindings%rowtype;
  storage_provision record;
  expected_count integer;
  pin_count integer;
  all_provisioned boolean;
  all_active boolean;
  changed_value boolean;
  binding_evidence jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
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
      message = 'Application installation activation command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
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

  select pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision
      and binding.content_fingerprint = required.dependency_content_fingerprint
      and binding.resolution_fingerprint = required.evidence_fingerprint
      and binding.content_fingerprint = module_release.content_fingerprint
      and binding.resolution_fingerprint = module_release.resolution_fingerprint
      and binding.generator_contract_version = '1.0.0', false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision
      and binding.content_fingerprint = required.dependency_content_fingerprint
      and binding.resolution_fingerprint = required.evidence_fingerprint
      and binding.content_fingerprint = module_release.content_fingerprint
      and binding.resolution_fingerprint = module_release.resolution_fingerprint
      and binding.generator_contract_version = '1.0.0', false
    ))
  into all_provisioned, all_active
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join vortex_definition.releases as module_release
    on module_release.root_id = required.target_root_id
    and module_release.release_revision = required.target_release_revision
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_provisioned is null or (not all_provisioned and not all_active)
    or exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select binding.* into strict locked_binding
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;

    if locked_binding.content_fingerprint <> storage_provision.content_fingerprint
      or locked_binding.resolution_fingerprint <> storage_provision.resolution_fingerprint
      or locked_binding.generator_contract_version <>
        storage_provision.generator_contract_version
      or locked_binding.storage_contract_ids <> storage_provision.storage_contract_ids then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;
  end loop;

  select snapshot.* into permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if not found
    or permission_snapshot.release_revision <> p_application_release_revision
    or permission_snapshot.definition_key <> (
      select root.key from vortex_definition.roots as root
      where root.root_id = p_application_root_id
    )
    or permission_snapshot.release_version <> application_release.release_version
    or permission_snapshot.validation_contract_version <> application_release.validation_contract_version
    or permission_snapshot.content_fingerprint <> application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint <> application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  changed_value := all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_module.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_module.installation_bindings as binding
    set state = 'active', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'provisioned';
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
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
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'active', 'changed', changed_value,
    'moduleBindings', binding_evidence
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
      message = 'Application installation activation command is invalid';
end
$function$;

revoke all on function vortex_module.activate_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.activate_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.activate_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic activation of the complete exact Module pin set for one Application release.';

create or replace function vortex_module.detach_application_installation(
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
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_detached boolean;
  changed_value boolean;
  binding_evidence jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
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
      message = 'Application installation detach command is invalid';
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

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
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

  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision
      and binding.content_fingerprint = required.dependency_content_fingerprint
      and binding.resolution_fingerprint = required.evidence_fingerprint, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'detached'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision
      and binding.content_fingerprint = required.dependency_content_fingerprint
      and binding.resolution_fingerprint = required.evidence_fingerprint, false
    ))
  into all_active, all_detached
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
  ) as expected on true
  ;
  if all_active is null or (not all_active and not all_detached)
    or exists (
      select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  changed_value := all_active;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_module.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_module.installation_bindings as binding
    set state = 'detached', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
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
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'detached', 'changed', changed_value,
    'moduleBindings', binding_evidence
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
      message = 'Application installation detach command is invalid';
end
$function$;

revoke all on function vortex_module.detach_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.detach_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.detach_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic detach of one complete Application Module binding set while retaining storage and records.';

reset role;

set local role vortex_record_owner;
create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_check text;
  owner_check text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array'
    or pg_catalog.jsonb_array_length(record_types) < 1 then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision
      and provision.content_fingerprint = release_row.content_fingerprint
      and provision.resolution_fingerprint = release_row.resolution_fingerprint
      and provision.generator_contract_version = '1.0.0';
    if result_storage_ids is null then
      raise exception using errcode = '55000', message = 'Stored release provision evidence is incompatible';
    end if;
    if result_storage_ids is distinct from (
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_context.is_non_nil_uuid(storage_id::text)
      or not vortex_context.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      scope_check := case storage_scope_value
        when 'organization_shared' then 'application_root_id is null'
        else 'application_root_id is not null'
      end;
      owner_check := case ownership_mode_value
        when 'organization_account' then
          'owner_organisation_account_id is not null and owner_group_id is null'
        when 'group' then
          'owner_organisation_account_id is null and owner_group_id is not null'
        else 'owner_organisation_account_id is null and owner_group_id is null'
      end;
      execute pg_catalog.format(
        'create table record_data.%I (
          organisation_id uuid not null references vortex_identity.organizations (organization_id),
          module_root_id uuid not null check (module_root_id = %L::uuid),
          record_type_id uuid not null check (record_type_id = %L::uuid),
          storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
          record_id uuid not null,
          application_root_id uuid,
          definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
          owner_organisation_account_id uuid,
          owner_group_id uuid,
          lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
          concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
          created_at timestamptz not null,
          created_by uuid not null,
          updated_at timestamptz not null,
          updated_by uuid not null,
          deleted_at timestamptz,
          deleted_by uuid,
          removal_due_at timestamptz,
          primary key (%s, record_id),
          foreign key (organisation_id, owner_organisation_account_id)
            references vortex_identity.organization_accounts (organization_id, organization_account_id),
          foreign key (organisation_id, owner_group_id)
            references vortex_access.organization_groups (organization_id, group_id),
          check (%s), check (%s),
          check ((deleted_at is null) = (deleted_by is null)),
          check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
          check (updated_at >= created_at)
        )', table_token, p_module_root_id, record_type_id_value, storage_id,
        scope_index_columns, scope_check, owner_check
      );
      execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
      execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
      execute pg_catalog.format(
        'create policy record_select on record_data.%I for select to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_update on record_data.%I for update to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        ) with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
        table_token
      );

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, generator_contract_version, content_fingerprint, record_type_definition
      ) values (
        storage_id, 'record_data', table_token, p_module_root_id,
        record_type_id_value, storage_scope_value, p_module_release_revision,
        p_module_release_revision, 'active', '1.0.0', shape_fingerprint, record_type
      );
      any_change := true;
    else
      if stored_catalogue.module_root_id <> p_module_root_id
        or stored_catalogue.record_type_id <> record_type_id_value
        or stored_catalogue.storage_scope <> storage_scope_value
        or stored_catalogue.state <> 'active'
        or stored_catalogue.generator_contract_version <> '1.0.0'
        or stored_catalogue.physical_schema_token <> 'record_data'
        or stored_catalogue.physical_table_token <> table_token
        or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_context.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if stored_catalogue.storage_contract_id is not null
          and (field_value ->> 'required')::boolean then
          raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s%s',
          table_token, column_token, sql_type,
          case when (field_value ->> 'required')::boolean then ' not null' else '' end
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        if (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  select pg_catalog.array_agg(value order by value) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, content_fingerprint, resolution_fingerprint,
    generator_contract_version, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, release_row.content_fingerprint,
    release_row.resolution_fingerprint, '1.0.0', result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    release_row.content_fingerprint, release_row.resolution_fingerprint,
    '1.0.0'::text, result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_module_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage for one published Module release and records its immutable provision evidence.';

create or replace function vortex_record.register_storage_conversion_plan(
  p_source_storage_contract_id uuid,
  p_source_field_id uuid,
  p_target_field_id uuid,
  p_source_release_revision bigint,
  p_target_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  source_release vortex_definition.releases%rowtype;
  target_release vortex_definition.releases%rowtype;
  source_record_types jsonb;
  target_record_types jsonb;
  source_field jsonb;
  target_field jsonb;
  semantic text;
  conversion_id uuid;
  inserted_count integer;
  stored vortex_record.storage_conversion_catalogue%rowtype;
begin
  if p_source_storage_contract_id is null
    or p_source_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id is null
    or p_source_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_field_id is null
    or p_target_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id = p_target_field_id
    or p_source_release_revision is null
    or p_source_release_revision not between 1 and 9007199254740991
    or p_target_release_revision is null
    or p_target_release_revision not between 1 and 9007199254740991
    or p_target_release_revision <= p_source_release_revision then
    raise exception using errcode = '22023',
      message = 'Storage conversion registration command is invalid';
  end if;

  authority := vortex_record.authorize_storage_conversion_internal(
    p_source_storage_contract_id, null
  );
  if not (authority ->> 'ownsModule')::boolean then
    raise exception using errcode = '42501',
      message = 'Storage conversion registration requires the Module owner';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_source_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or p_source_release_revision < catalogue_row.first_compatible_release_revision
    or (
      catalogue_row.last_compatible_release_revision is not null
      and p_source_release_revision > catalogue_row.last_compatible_release_revision
    ) then
    raise exception using errcode = '55000',
      message = 'Storage conversion source contract is unavailable';
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_source_storage_contract_id
    and mapping.field_id = p_source_field_id;
  if not found or source_mapping.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field is not active';
  end if;

  -- A target field that is already stored (active or retired) is not a
  -- conversion target; only an absent or already-planned target qualifies.
  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_source_storage_contract_id
    and mapping.field_id = p_target_field_id;
  if found and target_mapping.state <> 'planned' then
    raise exception using errcode = '55000',
      message = 'Storage conversion target field is already stored';
  end if;

  select release.* into source_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_source_release_revision;
  if not found
    or source_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('module_storage_conversion'))
    or source_release.compilation_output #>> '{kind}' <> 'module'
    or source_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or source_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('module_storage_conversion')) then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion source release is incompatible';
  end if;

  select release.* into target_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_target_release_revision;
  if not found
    or target_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('module_storage_conversion'))
    or target_release.compilation_output #>> '{kind}' <> 'module'
    or target_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or target_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('module_storage_conversion')) then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion target release is incompatible';
  end if;

  source_record_types := source_release.compilation_output
    #> '{canonical,content,recordTypes}';
  target_record_types := target_release.compilation_output
    #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(source_record_types) is distinct from 'array'
    or pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Storage conversion release content is incompatible';
  end if;

  select field_item.value into source_field
  from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_source_field_id;
  if source_field is null
    or vortex_record.database_value_type(source_field)
      is distinct from source_mapping.database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field evidence is incompatible';
  end if;

  select field_item.value into target_field
  from pg_catalog.jsonb_array_elements(target_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_target_field_id;
  if target_field is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion target field is not published';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as field_item(value)
    where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
      and (field_item.value ->> 'fieldId')::uuid = p_target_field_id
  ) then
    raise exception using errcode = '23514',
      message = 'Storage conversion target field already exists in the source release';
  end if;

  semantic := vortex_record.conversion_semantic_for_fields(source_field, target_field);
  if semantic is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion pair is unsupported';
  end if;

  conversion_id := vortex_record.storage_conversion_contract_identity(
    p_source_storage_contract_id, p_source_field_id, p_target_field_id
  );

  insert into vortex_record.storage_conversion_catalogue (
    conversion_contract_id, source_storage_contract_id, target_storage_contract_id,
    source_field_id, target_field_id, source_database_value_type,
    target_database_value_type, conversion_semantic, source_release_revision,
    target_release_revision, source_field_definition, target_field_definition
  ) values (
    conversion_id, p_source_storage_contract_id, p_source_storage_contract_id,
    p_source_field_id, p_target_field_id, source_mapping.database_value_type,
    vortex_record.database_value_type(target_field), semantic,
    p_source_release_revision, p_target_release_revision, source_field, target_field
  )
  on conflict (conversion_contract_id) do nothing;
  get diagnostics inserted_count = row_count;

  select stored_entry.* into stored
  from vortex_record.storage_conversion_catalogue as stored_entry
  where stored_entry.conversion_contract_id = conversion_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion catalogue write failed';
  end if;

  -- An entry is immutable once registered: a plan, its staged mapping and its
  -- progress all depend on exactly this evidence.
  if inserted_count = 0 and (
    stored.source_database_value_type is distinct from source_mapping.database_value_type
    or stored.target_database_value_type
      is distinct from vortex_record.database_value_type(target_field)
    or stored.conversion_semantic is distinct from semantic
    or stored.source_release_revision is distinct from p_source_release_revision
    or stored.target_release_revision is distinct from p_target_release_revision
    or stored.source_field_definition is distinct from source_field
    or stored.target_field_definition is distinct from target_field
  ) then
    raise exception using errcode = '55000',
      message = 'Storage conversion is already registered with different evidence';
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', stored.conversion_contract_id,
    'storageContractId', stored.source_storage_contract_id,
    'sourceFieldId', stored.source_field_id,
    'targetFieldId', stored.target_field_id,
    'conversionSemantic', stored.conversion_semantic,
    'sourceDatabaseValueType', stored.source_database_value_type,
    'targetDatabaseValueType', stored.target_database_value_type,
    'sourceReleaseRevision', stored.source_release_revision,
    'targetReleaseRevision', stored.target_release_revision,
    'changed', inserted_count > 0
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion release evidence is unavailable';
end
$function$;

revoke all on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) is
  'Records one immutable conversion catalogue entry from the caller-owned Module''s exact published source mapping and target release evidence; refuses any caller-authored type or unsupported pair.';

reset role;

create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  seen_field_ids text[];
  seen_relationship_ids text[] := array[]::text[];
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Record types: unique identity, well-formed ownership/field shape.
  for record_type_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_type_item) <> 'object'
      or not (record_type_item ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_type_item) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'storageContractId')
      or record_type_item ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item ? 'ownershipRelationshipId') <> (record_type_item ->> 'ownershipMode' = 'inherited'))
      or (record_type_item ? 'ownershipRelationshipId'
        and not vortex_context.is_non_nil_uuid(record_type_item ->> 'ownershipRelationshipId'))
      or (record_type_item ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item -> 'validationContractVersion') <> 'string'
        or record_type_item ->> 'validationContractVersion' <> all (vortex_definition.accepted_contract_version('record_type'))
      ))
      or pg_catalog.jsonb_typeof(record_type_item -> 'fields') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_type_item ->> 'recordTypeId') = any (seen_type_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_type_ids := pg_catalog.array_append(seen_type_ids, pg_catalog.lower(record_type_item ->> 'recordTypeId'));

    seen_field_ids := array[]::text[];
    for field_item in
      select value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'object'
        or not (field_item ?& array['fieldId', 'type'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(field_item) as supplied(key)
          where supplied.key <> all (array['fieldId', 'type', 'settings'])
        )
        or not vortex_context.is_non_nil_uuid(field_item ->> 'fieldId')
        or pg_catalog.jsonb_typeof(field_item -> 'type') <> 'string'
        or (field_item ? 'settings' and pg_catalog.jsonb_typeof(field_item -> 'settings') <> 'object') then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      if pg_catalog.lower(field_item ->> 'fieldId') = any (seen_field_ids) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      seen_field_ids := pg_catalog.array_append(seen_field_ids, pg_catalog.lower(field_item ->> 'fieldId'));
    end loop;
  end loop;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every declared target: one for a link, several for a link to one of
  -- several record types.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(relationship_item -> 'toRecordTypes') = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1 from pg_catalog.jsonb_object_keys(target.value) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_context.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(target.value ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object('recordId', p_target_record_id, 'action', p_declaration -> 'action');

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at, p_declaration -> 'recentAuthentication'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'direct_share' then 2
          when 'relationship' then 3
        end,
        coalesce(
          contribution.value -> 'route' ->> 'directShareId',
          contribution.value -> 'route' ->> 'sourceRecordId',
          ''
        )
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select pg_catalog.to_char(
    pg_catalog.timezone('UTC', pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

revoke execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner;
grant execute on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_access.evaluate_organization_record_access_internal(jsonb, uuid, jsonb) is
  'The complete exact-record access decision: unions every eligible alternative''s own complete row scope and always carries the exact recordId. Owner-only except for the fixed record adapter.';
