-- Stage upgrade storage separately so current installation readers keep seeing the active bindings.

begin;

set local role vortex_module_owner;

create table vortex_module.staged_installation_bindings (
  organization_id uuid not null references vortex_identity.organizations,
  application_root_id uuid not null,
  application_release_revision bigint not null
    check (application_release_revision between 1 and 9007199254740991),
  module_root_id uuid not null,
  module_release_revision bigint not null
    check (module_release_revision between 1 and 9007199254740991),
  binding_revision bigint not null check (binding_revision between 1 and 9007199254740991),
  base_binding_revision bigint
    check (base_binding_revision between 1 and 9007199254740991),
  base_binding_state text check (base_binding_state in ('active', 'detached')),
  storage_contract_ids uuid[] not null
    check (pg_catalog.cardinality(storage_contract_ids) > 0),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (
    organization_id, application_root_id, application_release_revision, module_root_id
  ),
  foreign key (application_root_id, application_release_revision)
    references vortex_definition.releases (root_id, release_revision),
  foreign key (module_root_id, module_release_revision)
    references vortex_definition.releases (root_id, release_revision),
  check ((base_binding_revision is null) = (base_binding_state is null))
);

alter table vortex_module.staged_installation_bindings enable row level security;
alter table vortex_module.staged_installation_bindings force row level security;
create policy staged_installation_bindings_owner
  on vortex_module.staged_installation_bindings
  to vortex_module_owner using (true) with check (true);
revoke all on table vortex_module.staged_installation_bindings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on table vortex_module.staged_installation_bindings is
  'Private exact-release Module bindings prepared for an Application upgrade and invisible to active installation reads.';

reset role;

set local role vortex_module_owner;
grant usage, create on schema vortex_module to postgres;
reset role;

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
  staged_binding vortex_module.staged_installation_bindings%rowtype;
  provision record;
  active_application_release_revision bigint;
  next_binding_revision bigint;
  binding_exists boolean;
  staged_binding_exists boolean;
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

  select pg_catalog.min(binding.application_release_revision)
  into active_application_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'active';
  if exists (
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state = 'active'
      and binding.application_release_revision <> active_application_release_revision
  ) then
    raise exception using errcode = '55000',
      message = 'Active Application installation is mixed';
  end if;

  if active_application_release_revision is not null then
    if p_application_release_revision <= active_application_release_revision then
      raise exception using errcode = '40001',
        message = 'Application installation candidate is not a newer release';
    end if;
    if exists (
      select 1 from vortex_module.staged_installation_bindings as staged
      where staged.organization_id = permission_decision.organization_id
        and staged.application_root_id = p_application_root_id
        and staged.application_release_revision <> p_application_release_revision
    ) then
      raise exception using errcode = '40001',
        message = 'Application installation candidate changed';
    end if;

    select binding.* into stored_binding
    from vortex_module.installation_bindings as binding
    where binding.organization_id = permission_decision.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = p_module_root_id
    for update;
    binding_exists := found;
    if (binding_exists and stored_binding.binding_revision is distinct from p_expected_binding_revision)
      or (not binding_exists and p_expected_binding_revision is not null)
      or (binding_exists and stored_binding.state not in ('active', 'detached')) then
      raise exception using errcode = '40001',
        message = 'Module installation binding changed';
    end if;

    select staged.* into staged_binding
    from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = permission_decision.organization_id
      and staged.application_root_id = p_application_root_id
      and staged.application_release_revision = p_application_release_revision
      and staged.module_root_id = p_module_root_id
    for update;
    staged_binding_exists := found;

    select storage.* into strict provision
    from vortex_record.provision_exact_module_storage(
      p_module_root_id, p_module_release_revision
    ) as storage;

    if staged_binding_exists then
      if staged_binding.module_release_revision <> p_module_release_revision
        or staged_binding.base_binding_revision is distinct from p_expected_binding_revision
        or staged_binding.base_binding_state is distinct from
          case when binding_exists then stored_binding.state else null end
        or staged_binding.storage_contract_ids <> provision.storage_contract_ids then
        raise exception using errcode = '40001',
          message = 'Staged Module installation evidence is incompatible';
      end if;
      return query select 'provisioned'::text, false, staged_binding.binding_revision,
        p_application_root_id, p_application_release_revision, p_module_root_id,
        p_module_release_revision, staged_binding.storage_contract_ids;
      return;
    end if;

    if p_expected_binding_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Module installation binding revision is exhausted';
    end if;
    next_binding_revision := coalesce(p_expected_binding_revision, 0) + 1;
    insert into vortex_module.staged_installation_bindings (
      organization_id, application_root_id, application_release_revision,
      module_root_id, module_release_revision, binding_revision,
      base_binding_revision, base_binding_state, storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id,
      p_application_release_revision, p_module_root_id, p_module_release_revision,
      next_binding_revision, p_expected_binding_revision,
      case when binding_exists then stored_binding.state else null end,
      provision.storage_contract_ids
    );

    return query select 'provisioned'::text, true, next_binding_revision,
      p_application_root_id, p_application_release_revision, p_module_root_id,
      p_module_release_revision, provision.storage_contract_ids;
    return;
  end if;

  if exists (
    select 1 from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = permission_decision.organization_id
      and staged.application_root_id = p_application_root_id
  ) then
    raise exception using errcode = '40001',
      message = 'Application installation candidate changed';
  end if;

  select binding.* into stored_binding
  from vortex_module.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  binding_exists := found;

  if binding_exists then
    if stored_binding.state in ('active', 'draining')
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
    if stored_binding.storage_contract_ids <> provision.storage_contract_ids then
      raise exception using errcode = '55000', message = 'Stored Module installation evidence is incompatible';
    end if;
    return query select stored_binding.state, false, stored_binding.binding_revision,
      stored_binding.application_root_id, stored_binding.application_release_revision,
      stored_binding.module_root_id, stored_binding.module_release_revision,
      stored_binding.storage_contract_ids;
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
      storage_contract_ids
    ) values (
      permission_decision.organization_id, p_application_root_id, p_module_root_id, 1,
      p_application_release_revision, p_module_release_revision, 'provisioned',
      provision.storage_contract_ids
    );
  end if;

  return query select 'provisioned'::text, true, next_binding_revision,
    p_application_root_id, p_application_release_revision, p_module_root_id,
    p_module_release_revision, provision.storage_contract_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module installation evidence is ambiguous';
end
$function$;

alter function vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint) owner to vortex_module_owner;

revoke all on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_module.provision_module_installation_storage(
  uuid, bigint, uuid, bigint, bigint
) is 'Protected exact-release storage provisioning; commits inactive first-install bindings and privately stages upgrade bindings while the current release stays active.';
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
  staged_binding vortex_module.staged_installation_bindings%rowtype;
  storage_provision record;
  expected_count integer;
  pin_count integer;
  staged_count integer;
  all_provisioned boolean;
  all_staged boolean;
  all_active boolean;
  binding_storage_contract_ids uuid[];
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
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      staged.binding_revision = expected.binding_revision
      and staged.application_release_revision = p_application_release_revision
      and staged.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_provisioned, all_staged, all_active
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_module.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join vortex_module.staged_installation_bindings as staged
    on staged.organization_id = initial_authority.organization_id
    and staged.application_root_id = p_application_root_id
    and staged.application_release_revision = p_application_release_revision
    and staged.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  select pg_catalog.count(*)::integer into staged_count
  from vortex_module.staged_installation_bindings as staged
  where staged.organization_id = initial_authority.organization_id
    and staged.application_root_id = p_application_root_id;
  if all_provisioned is null
    or (not all_provisioned and not all_staged and not all_active)
    or (all_provisioned and all_staged)
    or (staged_count > 0 and (not all_staged or staged_count <> pin_count))
    or exists (
      select 1 from vortex_module.staged_installation_bindings as staged
      where staged.organization_id = initial_authority.organization_id
        and staged.application_root_id = p_application_root_id
        and staged.application_release_revision <> p_application_release_revision
    )
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

  if all_staged and exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    join vortex_module.staged_installation_bindings as staged
      on staged.organization_id = initial_authority.organization_id
      and staged.application_root_id = p_application_root_id
      and staged.application_release_revision = p_application_release_revision
      and staged.module_root_id = required.target_root_id
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
    where (staged.base_binding_revision is null and binding.module_root_id is not null)
      or (staged.base_binding_revision is not null and binding.module_root_id is null)
      or (staged.base_binding_state = 'active'
        and (binding.state is distinct from 'detached'
          or binding.binding_revision <> staged.base_binding_revision + 1))
      or (staged.base_binding_state = 'detached'
        and (binding.state is distinct from 'detached'
          or binding.binding_revision <> staged.base_binding_revision))
  ) then
    raise exception using errcode = '40001',
      message = 'Staged Application installation base bindings changed';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    if all_staged then
      select staged.* into strict staged_binding
      from vortex_module.staged_installation_bindings as staged
      where staged.organization_id = initial_authority.organization_id
        and staged.application_root_id = p_application_root_id
        and staged.application_release_revision = p_application_release_revision
        and staged.module_root_id = pin.target_root_id;
      binding_storage_contract_ids := staged_binding.storage_contract_ids;
    else
      select binding.* into strict locked_binding
      from vortex_module.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = pin.target_root_id;
      binding_storage_contract_ids := locked_binding.storage_contract_ids;
    end if;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;

    if binding_storage_contract_ids <> storage_provision.storage_contract_ids then
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

  changed_value := all_provisioned or all_staged;
  if all_provisioned then
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
  elsif all_staged then
    for pin in
      select required.*
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      order by required.target_root_id
    loop
      select staged.* into strict staged_binding
      from vortex_module.staged_installation_bindings as staged
      where staged.organization_id = initial_authority.organization_id
        and staged.application_root_id = p_application_root_id
        and staged.application_release_revision = p_application_release_revision
        and staged.module_root_id = pin.target_root_id;
      if staged_binding.binding_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Module installation binding revision is exhausted';
      end if;

      insert into vortex_module.installation_bindings (
        organization_id, application_root_id, module_root_id, binding_revision,
        application_release_revision, module_release_revision, state,
        storage_contract_ids
      ) values (
        initial_authority.organization_id, p_application_root_id,
        staged_binding.module_root_id, staged_binding.binding_revision + 1,
        p_application_release_revision, staged_binding.module_release_revision,
        'active', staged_binding.storage_contract_ids
      )
      on conflict (organization_id, application_root_id, module_root_id)
      do update set
        binding_revision = excluded.binding_revision,
        application_release_revision = excluded.application_release_revision,
        module_release_revision = excluded.module_release_revision,
        state = excluded.state,
        storage_contract_ids = excluded.storage_contract_ids,
        changed_at = pg_catalog.statement_timestamp()
      where vortex_module.installation_bindings.state = 'detached'
        and vortex_module.installation_bindings.binding_revision =
          case staged_binding.base_binding_state
            when 'active' then staged_binding.base_binding_revision + 1
            else staged_binding.base_binding_revision
          end;
      if not found then
        raise exception using errcode = '40001',
          message = 'Staged Application installation binding changed';
      end if;
    end loop;

    delete from vortex_module.staged_installation_bindings as staged
    where staged.organization_id = initial_authority.organization_id
      and staged.application_root_id = p_application_root_id;
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

alter function vortex_module.activate_application_installation(uuid,bigint,jsonb) owner to vortex_module_owner;

revoke all on function vortex_module.activate_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.activate_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_module.activate_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic activation of one complete exact Module pin set, promoting a staged upgrade binding set while retaining the previous release until the transaction commits.';
create or replace function vortex_module.read_application_installation_bindings(
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
  binding_evidence jsonb;
  staged_binding_evidence jsonb;
  registered_release_revision bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application installation read command is invalid';
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

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into binding_evidence
  from vortex_module.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', staged.organization_id,
      'applicationRootId', staged.application_root_id,
      'moduleRootId', staged.module_root_id,
      'bindingRevision', staged.binding_revision,
      'applicationReleaseRevision', staged.application_release_revision,
      'moduleReleaseRevision', staged.module_release_revision,
      'state', 'provisioned'
    ) order by staged.application_release_revision, staged.module_root_id), '[]'::jsonb)
  into staged_binding_evidence
  from vortex_module.staged_installation_bindings as staged
  where staged.organization_id = authority.organization_id
    and staged.application_root_id = p_application_root_id;

  -- The exact release the active permission registration was prepared from,
  -- or null when it is absent or withdrawn. The fixed activation requires it
  -- to name the release being activated.
  select snapshot.release_revision into registered_release_revision
  from vortex_access.read_application_permission_snapshot(
    authority.organization_id, p_application_root_id
  ) as snapshot;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority.organization_id,
    'applicationRootId', p_application_root_id,
    'registeredReleaseRevision', registered_release_revision,
    'moduleBindings', binding_evidence,
    'stagedModuleBindings', staged_binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
end
$function$;

alter function vortex_module.read_application_installation_bindings(uuid) owner to vortex_module_owner;

revoke all on function vortex_module.read_application_installation_bindings(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_application_installation_bindings(uuid)
  to vortex_request;
comment on function vortex_module.read_application_installation_bindings(uuid) is
  'Installer-only read of current and staged Module bindings plus the registered release under application-management authority.';
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

set local role vortex_module_owner;
revoke usage, create on schema vortex_module from postgres;
reset role;

commit;
