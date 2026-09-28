-- #1461 Tenant and cluster identity definers use the Identity owner.

begin;

-- Privileges for the tenant, cluster and administrator definers owned by vortex_identity_owner.
grant select (organization_id, tenant_id, parent_organization_id, state)
  on table vortex_identity.organizations to vortex_identity_owner;
grant select (tenant_id, state)
  on table vortex_identity.tenants to vortex_identity_owner;
grant select (assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at, revoked_at)
  on table vortex_identity.tenant_administrator_assignments to vortex_identity_owner;
grant select (identity_id, state)
  on table vortex_identity.identity_projections to vortex_identity_owner;

create policy identity_owner_1461_organizations_select
  on vortex_identity.organizations for select to vortex_identity_owner using (true);
create policy identity_owner_1461_tenants_select
  on vortex_identity.tenants for select to vortex_identity_owner using (true);
create policy identity_owner_1461_tenant_administrator_assignments_select
  on vortex_identity.tenant_administrator_assignments for select to vortex_identity_owner using (true);
create policy identity_owner_1461_identity_projections_select
  on vortex_identity.identity_projections for select to vortex_identity_owner using (true);

-- Canonical source: vortex_identity.adopt_organization.
create or replace function vortex_identity.adopt_organization(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_steward_identity_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  requirement vortex_access.organization_stewardship_requirements%rowtype;
  account_revision bigint;
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  authoritative_tenant_id uuid;
  authoritative_organization_id uuid;
  authoritative_account_id uuid;
begin
  if not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_steward_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Organization adoption input is invalid';
  end if;

  -- This is deliberately an unlocked eligibility probe. Existing request
  -- resolution locks Access first and then authoritatively locks Identity, so
  -- adoption must follow that same order.
  perform 1
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
    and organization.state = 'active'
    and tenant.state = 'active';
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'adopt_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if not receipt.subject_ids @> array[p_organization_id, p_organization_account_id] then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_organization'::text,
      p_tenant_id, p_organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_id)],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  if exists (
    select 1 from vortex_identity.accepted_administration_receipts as prior
    where prior.tenant_id = p_tenant_id
      and prior.operation_key = 'adopt_organization'
      and prior.subject_ids @> array[p_organization_id]
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, account.revision
  into authoritative_tenant_id, authoritative_organization_id,
    authoritative_account_id, account_revision
  from vortex_identity.resolve_active_organization_account(
    p_steward_identity_id, p_organization_id
  ) as scope
  join vortex_identity.organization_accounts as account
    on account.organization_account_id = scope.organization_account_id;
  if not found or authoritative_account_id is distinct from p_organization_account_id then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;
  if authoritative_tenant_id is distinct from p_tenant_id
    or authoritative_organization_id is distinct from p_organization_id then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select stored.* into requirement
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;
  if found then
    if requirement.original_organization_account_id <> p_organization_account_id then
      raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
    end if;
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id,
      requirement.original_role_id, 'organization_steward',
      'Organisation steward', 'Permanent minimum organisation administration.',
      requirement.original_role_assignment_id,
      requirement.original_delegation_authority_id,
      requirement.adopted_by, requirement.adoption_correlation_id
    ) as adopted;
  else
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id, new_role_id,
      'organization_steward', 'Organisation steward',
      'Permanent minimum organisation administration.',
      new_role_assignment_id, new_delegation_id, p_operator_actor_id,
      new_correlation_id
    ) as adopted;
  end if;

  -- #33 queues this evidence trigger. Validate it while the privileged boundary
  -- is still active so a runtime-role commit cannot bypass or fail its reads.
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    immediate;
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (p_organization_id, resulting_access_version),
    (p_organization_account_id, account_revision)
  ) as result(subject_id, subject_revision);
  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_tenant_id,
    'adopt_organization', p_duplicate_key, p_command_fingerprint,
    result_subject_ids, result_subject_revisions, operation_at
  );
  return query select 'accepted'::text, 'adopt_organization'::text,
    p_tenant_id, p_organization_id, p_organization_account_id,
    resulting_access_version, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) is 'Configured-system-only explicit organisation stewardship adoption through the existing Access coordinator.';

alter function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) owner to postgres;

-- Canonical source: vortex_identity.adopt_tenant.
create or replace function vortex_identity.adopt_tenant(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_tenant_steward_identity_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  tenant_revision bigint;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_assignment_id uuid;
begin
  if not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(p_tenant_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant adoption input is invalid';
  end if;

  select tenant.revision into tenant_revision
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'adopt_tenant'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(receipt.subject_ids);
    if replay_assignment_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_tenant'::text, p_tenant_id,
      replay_assignment_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, replay_assignment_id)],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  if exists (
    select 1 from vortex_identity.accepted_administration_receipts as prior
    where (prior.tenant_id = p_tenant_id and prior.operation_key = 'adopt_tenant')
      or (prior.cluster_id is not null and prior.operation_key = 'provision_tenant'
          and prior.subject_ids @> array[p_tenant_id])
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_identity.identity_projections as projection
  where projection.identity_id = p_tenant_steward_identity_id
    and projection.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  if exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.state = 'active'
      and not vortex_access.organization_has_permanent_steward(
        organization.organization_id, operation_at
      )
  ) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_assignment_id, p_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values (p_tenant_id, tenant_revision), (new_assignment_id, 1::bigint))
    as result(subject_id, subject_revision);
  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_tenant_id, 'adopt_tenant',
    p_duplicate_key, p_command_fingerprint, result_subject_ids,
    result_subject_revisions, operation_at
  );
  return query select 'accepted'::text, 'adopt_tenant'::text, p_tenant_id,
    new_assignment_id, 1::bigint, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';

alter function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) owner to postgres;

-- Canonical source: vortex_identity.apply_configured_cluster_identity_lifecycle.
create or replace function vortex_identity.apply_configured_cluster_identity_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_identity_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  identity_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  initial_tenant_ids uuid[];
  current_tenant_ids uuid[];
  current_state text;
  current_revision bigint;
  current_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in (
      'suspend_cluster_identity',
      'reactivate_cluster_identity',
      'close_cluster_identity'
    )
    or p_cluster_id is null
    or not vortex_context.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Cluster identity lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.cluster_id = p_cluster_id
    and stored.operation_key = p_operation
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> p_command_fingerprint
      or not receipt.subject_ids @> array[p_identity_id] then
      raise exception using errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_operation, p_identity_id,
      receipt.subject_revisions[
        pg_catalog.array_position(receipt.subject_ids, p_identity_id)
      ], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into initial_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = any(initial_tenant_ids)
  order by tenant.tenant_id
  for update;

  select projection.state, projection.revision, projection.state_changed_at
  into current_state, current_revision, current_changed_at
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into current_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  if current_organization_ids is distinct from initial_organization_ids
    or current_tenant_ids is distinct from initial_tenant_ids then
    raise exception using errcode = 'V3102',
      message = 'Cluster identity scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Identity projection revision is stale';
  end if;

  case p_operation
    when 'suspend_cluster_identity' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_cluster_identity' then
      required_source_state := 'suspended';
      resulting_state := 'active';
    when 'close_cluster_identity' then
      if current_state not in ('active', 'suspended') then
        raise exception using errcode = 'V3003',
          message = 'Administration scope is unavailable';
      end if;
      resulting_state := 'closed';
  end case;
  if required_source_state is not null and current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Eligibility is always evaluated against a fresh database observation made
  -- after every governance and projection lock. A future-skewed audit value is
  -- compatible with the projection trigger, but never grants future authority.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_changed_at);
  resulting_revision := current_revision + 1;
  update vortex_identity.identity_projections as projection
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    state_changed_by = p_operator_actor_id,
    state_change_correlation_id = new_correlation_id,
    revision = resulting_revision
  where projection.identity_id = p_identity_id;

  if exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = any(current_organization_ids)
      and not vortex_access.organization_has_permanent_steward(
        requirement.organization_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent organisation steward is required';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(current_tenant_ids) as affected(tenant_id)
    where (
        exists (
          select 1
          from vortex_identity.accepted_administration_receipts as adoption
          where adoption.tenant_id = affected.tenant_id
            and adoption.operation_key = 'adopt_tenant'
        )
        or exists (
          select 1
          from vortex_identity.accepted_administration_receipts as provisioning
          where provisioning.cluster_id is not null
            and provisioning.operation_key = 'provision_tenant'
            and provisioning.subject_ids @> array[affected.tenant_id]
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        affected.tenant_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent tenant manager is required';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, cluster_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_cluster_id, p_operation,
    p_duplicate_key, p_command_fingerprint, array[p_identity_id],
    array[resulting_revision], evaluated_at
  );

  return query select 'accepted'::text, p_operation, p_identity_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_identity_owner;

comment on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) is 'Private exact composition for the three configured-system cluster-local identity lifecycle commands.';

alter function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.apply_configured_tenant_lifecycle.
create or replace function vortex_identity.apply_configured_tenant_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  current_state text;
  current_revision bigint;
  current_state_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in ('suspend_tenant', 'reactivate_tenant')
    or p_cluster_id is null
    or not vortex_context.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Configured tenant lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.cluster_id = p_cluster_id
    and stored.operation_key = p_operation
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> p_command_fingerprint
      or receipt.subject_ids <> array[p_tenant_id] then
      raise exception using errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_operation, p_tenant_id,
      receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  select tenant.state, tenant.revision, tenant.state_changed_at
  into current_state, current_revision, current_state_changed_at
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  if current_organization_ids is distinct from initial_organization_ids then
    raise exception using errcode = 'V3102',
      message = 'Tenant organisation scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Tenant revision is stale';
  end if;

  case p_operation
    when 'suspend_tenant' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_tenant' then
      required_source_state := 'suspended';
      resulting_state := 'active';
  end case;
  if current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Authority readiness always uses a fresh observation after all scope locks.
  -- A future-skewed existing audit value is only clamped for persistence.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_state_changed_at);

  if p_operation = 'reactivate_tenant' then
    if (
        exists (
          select 1
          from vortex_identity.accepted_administration_receipts as adoption
          where adoption.tenant_id = p_tenant_id
            and adoption.operation_key = 'adopt_tenant'
        )
        or exists (
          select 1
          from vortex_identity.accepted_administration_receipts as provisioning
          where provisioning.cluster_id is not null
            and provisioning.operation_key = 'provision_tenant'
            and provisioning.subject_ids @> array[p_tenant_id]
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        p_tenant_id, evaluated_at
      ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent tenant manager is required';
    end if;

    if exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      join vortex_identity.organizations as organization
        on organization.organization_id = requirement.organization_id
      where organization.tenant_id = p_tenant_id
        and not vortex_access.organization_has_permanent_steward(
          requirement.organization_id, evaluated_at
        )
    ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent organisation steward is required';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.tenants as tenant
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    revision = resulting_revision
  where tenant.tenant_id = p_tenant_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, cluster_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_cluster_id, p_operation,
    p_duplicate_key, p_command_fingerprint, array[p_tenant_id],
    array[resulting_revision], evaluated_at
  );

  return query select 'accepted'::text, p_operation, p_tenant_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_identity_owner;

comment on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) is 'Private exact composition for configured-system tenant suspension and reactivation.';

alter function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.archive_tenant_organization.
create or replace function vortex_identity.archive_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation archive command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'archive_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state not in ('active', 'suspended')
    or exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = p_tenant_id
        and child.parent_organization_id = p_organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'archived',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'archive_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'archive_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.archive_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.change_tenant_administrator.
create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or capabilities is null or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  if target_identity_id is null or not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = target_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if target_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'change_tenant_administrator',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text,
      pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'change_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not (
      'platform.tenant.administrators.manage' = any(capabilities)
      and p_starts_at <= evaluated_at and p_expires_at is null
    ) and not vortex_identity.tenant_has_permanent_manager(
      p_tenant_id, evaluated_at, p_assignment_id
    ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set capability_keys = capabilities, starts_at = p_starts_at,
    expires_at = p_expires_at, revision = resulting_revision,
    changed_at = evaluated_at, changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'change_tenant_administrator', p_duplicate_key, computed_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

alter function vortex_identity.change_tenant_administrator(uuid,text,uuid,uuid,bigint,jsonb,timestamp with time zone,timestamp with time zone) owner to postgres;

-- Canonical source: vortex_identity.close_cluster_identity.
create or replace function vortex_identity.close_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'close_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_command_fingerprint, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only terminal closure of one cluster-local identity projection.';

alter function vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.create_tenant_organization.
create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_parent_organization_id uuid,
  p_organization_short_name text,
  p_organization_display_name text,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_organization_id uuid;
  replay_account_id uuid;
  required_projection_count bigint;
  active_projection_count bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_display_name is null
    or p_organization_display_name is distinct from pg_catalog.btrim(p_organization_display_name)
    or pg_catalog.char_length(p_organization_display_name) not between 1 and 120
    or p_account_display_name is null
    or p_account_display_name is distinct from pg_catalog.btrim(p_account_display_name)
    or pg_catalog.char_length(p_account_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation creation command is invalid';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  -- Tenant serialization converges duplicate and short-name races and keeps a
  -- parent lifecycle change from crossing this creation decision.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Identity lifecycle writers use the same projection rows. Lock caller and
  -- nominee in stable order, but defer eligibility checks until after replay.
  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
  order by projection.identity_id
  for share;

  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'create_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(receipt.subject_ids);
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(receipt.subject_ids);
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      receipt.subject_revisions[
        pg_catalog.array_position(receipt.subject_ids, replay_account_id)
      ],
      receipt.subject_revisions[
        pg_catalog.array_position(receipt.subject_ids, replay_organization_id)
      ],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select pg_catalog.count(distinct nominated.identity_id)
  into required_projection_count
  from (values
    (actor_identity_id),
    (p_organization_steward_identity_id)
  ) as nominated(identity_id);
  select pg_catalog.count(distinct projection.identity_id)
  into active_projection_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
    and projection.state = 'active';
  if active_projection_count <> required_projection_count then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if p_parent_organization_id is not null
    and not exists (
      select 1
      from vortex_identity.organizations as parent
      where parent.tenant_id = p_tenant_id
        and parent.organization_id = p_parent_organization_id
        and parent.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Re-evaluate after all locks on existing facts. No creator membership or
  -- projection fallback is inferred from the tenant assignment.
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  begin
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, p_tenant_id, p_parent_organization_id,
      p_organization_short_name, p_organization_display_name, 'active',
      evaluated_at, actor_identity_id, evaluated_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    evaluated_at, evaluated_at, evaluated_at, actor_identity_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, actor_identity_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, actor_identity_id, new_correlation_id
  );

  select adopted.access_version
  into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, actor_identity_id,
    new_correlation_id
  ) as adopted;

  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    immediate;
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'create_tenant_organization', p_duplicate_key, p_command_fingerprint,
    result_subject_ids, result_subject_revisions, evaluated_at
  );

  return query
  select 'accepted'::text,
    'create_tenant_organization'::text,
    new_organization_id,
    1::bigint,
    new_account_id,
    1::bigint,
    resulting_access_version,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings and delivered Access composition.';

alter function vortex_identity.create_tenant_organization(uuid,text,uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text) owner to postgres;

-- Canonical source: vortex_identity.grant_tenant_administrator.
create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_subject_identity_id uuid,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' or capabilities is null
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  perform 1 from vortex_identity.identity_projections projection
    where projection.identity_id in (actor_identity_id, p_subject_identity_id)
    order by projection.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.identity_id = actor_identity_id
    order by assignment.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant_tenant_administrator',
      p_tenant_id::text, p_subject_identity_id::text, pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'grant_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      receipt.subject_ids[1], receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  insert into vortex_identity.tenant_administrator_assignments values (
    new_assignment_id, p_tenant_id, p_subject_identity_id, capabilities, p_starts_at, p_expires_at, 1,
    evaluated_at, actor_identity_id, new_correlation_id, evaluated_at, actor_identity_id, new_correlation_id, null, null, null
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id, 'grant_tenant_administrator',
    p_duplicate_key, computed_fingerprint, array[new_assignment_id], array[1::bigint], evaluated_at
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

alter function vortex_identity.grant_tenant_administrator(uuid,text,uuid,uuid,jsonb,timestamp with time zone,timestamp with time zone) owner to postgres;

-- Canonical source: vortex_identity.list_organizations_projection.
create or replace function vortex_identity.list_organizations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.hierarchy.read capability the bespoke tenant-structure reader
  -- requires is the only visibility, and the tenant is the caller's own resolved
  -- tenant, never page input. Exactly as that reader, a viewer the capability
  -- admits sees every organisation of that one tenant, and a viewer it refuses
  -- sees no row, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the organisation and the revision is the
  -- organisation's own revision; its position in the tenant hierarchy is the
  -- parent reference the projection returns. The tenant structure is a
  -- governance fact rather than an organisation-owned row, so the projected
  -- organisation is the organisation the record is read in, the one the caller's
  -- validated request context already established. Creation and state-change
  -- evidence stay in the protected storage and are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id,
      visible_tenant_id,
      'platform.tenant.hierarchy.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  return query
  select
    visible_organization_id,
    organization.organization_id,
    organization.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', organization.tenant_id,
      'parent_organization_id', organization.parent_organization_id,
      'short_name', organization.short_name,
      'display_name', organization.display_name,
      'state', organization.state,
      'state_changed_at', organization.state_changed_at,
      'created_at', organization.created_at
    )
  from vortex_identity.organizations as organization
  where organization.tenant_id = visible_tenant_id
    and (p_record_id is null or p_record_id = organization.organization_id)
  order by organization.organization_id;
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_organizations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_organizations_projection(uuid, integer) is
  'Registered organisation projection: returns every organisation of the current viewer''s own tenant under the fixed platform.tenant.hierarchy.read capability, the exact rule the tenant-structure reader applies, with the organisation the record is read in, the organisation identity, the organisation revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. Creation and state-change evidence are never projected.';

alter function vortex_identity.list_organizations_projection(uuid,integer) owner to postgres;

-- Canonical source: vortex_identity.list_tenant_administrator_assignments.
create or replace function vortex_identity.list_tenant_administrator_assignments(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
)
returns table (assignment_id uuid, identity_id uuid, capability_keys text[], starts_at timestamptz, expires_at timestamptz, revision bigint, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant assignment request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.administrators.read',
    evaluated_at
  );
  return query
  select assignment.assignment_id, assignment.identity_id, assignment.capability_keys,
    assignment.starts_at, assignment.expires_at, assignment.revision,
    case when assignment.revoked_at is not null and assignment.revoked_at <= evaluated_at then 'revoked'
      when assignment.starts_at > evaluated_at then 'scheduled'
      when assignment.expires_at is not null and assignment.expires_at <= evaluated_at then 'expired'
      else 'active' end
  from vortex_identity.tenant_administrator_assignments assignment
  where assignment.tenant_id = p_tenant_id
    and (p_after is null or assignment.assignment_id > p_after)
  order by assignment.assignment_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid) is
  'Bounded deterministic same-tenant assignment read under the bound request context person''s exact administrators.read capability.';

alter function vortex_identity.list_tenant_administrator_assignments(uuid,integer,uuid) owner to postgres;

-- Canonical source: vortex_identity.list_tenant_administrators_projection.
create or replace function vortex_identity.list_tenant_administrators_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.administrators.read capability the bespoke tenant-administration
  -- reader requires is the only visibility, and the tenant is the caller's own
  -- resolved tenant, never page input. A viewer the capability refuses sees no
  -- rows, exactly as a missing or foreign record, so the record adapters return
  -- their identical refusal and a list page is empty rather than failing. The
  -- record identity is the assignment and the revision is the assignment's own
  -- revision. Every assignment of the tenant is listed, whether scheduled, active,
  -- expired or revoked, and the projected state is descriptive: it grants nothing
  -- and is exactly the derived outcome the bespoke reader returns. The grant,
  -- revocation and correlation audit columns are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id,
      visible_tenant_id,
      'platform.tenant.administrators.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  return query
  select
    visible_organization_id,
    assignment.assignment_id,
    assignment.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', assignment.tenant_id,
      'identity_id', assignment.identity_id,
      'capability_keys', assignment.capability_keys,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', case
        when assignment.revoked_at is not null
          and assignment.revoked_at <= evaluated_at then 'revoked'
        when assignment.starts_at > evaluated_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= evaluated_at then 'expired'
        else 'active'
      end
    )
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = visible_tenant_id
    and (p_record_id is null or p_record_id = assignment.assignment_id)
  order by assignment.assignment_id;
end
$function$;

revoke all on function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenant_administrators_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenant_administrators_projection(uuid, integer) is
  'Registered tenant-administrator projection: returns every administrator assignment of the caller''s own tenant, whether scheduled, active, expired or revoked, under the fixed platform.tenant.administrators.read capability, with the organisation the record is read in, the assignment identity, the assignment revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. The projected state grants nothing and grant or revocation evidence is never projected.';

alter function vortex_identity.list_tenant_administrators_projection(uuid,integer) owner to postgres;

-- Canonical source: vortex_identity.list_tenant_hierarchy.
create or replace function vortex_identity.list_tenant_hierarchy(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant hierarchy request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.hierarchy.read',
    pg_catalog.clock_timestamp()
  );
  return query
  select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and (p_after is null or organization.organization_id > p_after)
  order by organization.organization_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid) is
  'Bounded deterministic same-tenant structural hierarchy read under the bound request context person''s exact hierarchy.read capability.';

alter function vortex_identity.list_tenant_hierarchy(uuid,integer,uuid) owner to postgres;

-- Canonical source: vortex_identity.list_tenant_launcher.
create or replace function vortex_identity.list_tenant_launcher(
  p_limit integer,
  p_after uuid default null
)
returns table (tenant_id uuid, display_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023',
      message = 'Tenant launcher request is invalid';
  end if;
  if not exists (
    select 1 from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id and identity.state = 'active'
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  return query
  select tenant.tenant_id, tenant.display_name
  from vortex_identity.tenants as tenant
  where tenant.state = 'active'
    and (p_after is null or tenant.tenant_id > p_after)
    and (
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      ) is not null
      or exists (
        select 1
        from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = actor_identity_id
          and assignment.revoked_at is null
          and assignment.starts_at <= evaluated_at
          and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
      )
    )
  order by tenant.tenant_id
  limit p_limit;
end
$function$;

revoke all on function vortex_identity.list_tenant_launcher(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_launcher(integer, uuid) is
  'Lists active tenants assigned to the bound identity, or all active tenants for a named Vortex super administrator.';

alter function vortex_identity.list_tenant_launcher(integer,uuid) owner to postgres;

-- Canonical source: vortex_identity.list_tenants_projection.
create or replace function vortex_identity.list_tenants_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same effective
  -- structural administrator assignment the bespoke tenant launcher applies is
  -- the only visibility, and neither the tenant nor the organisation is ever an
  -- input. A viewer with no effective assignment sees no rows, exactly as a
  -- missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the tenant and the revision is the tenant's own revision. A tenant is a
  -- governance boundary rather than an organisation-owned row, so the projected
  -- organisation is the organisation the record is read in, the one the caller's
  -- validated request context already established; capability evidence and every
  -- grant, revocation and correlation column stay in the protected storage and
  -- are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  return query
  select
    visible_organization_id,
    tenant.tenant_id,
    tenant.revision,
    pg_catalog.jsonb_build_object(
      'short_name', tenant.short_name,
      'display_name', tenant.display_name,
      'state', tenant.state,
      'state_changed_at', tenant.state_changed_at,
      'created_at', tenant.created_at
    )
  from vortex_identity.tenants as tenant
  where tenant.state = 'active'
    and (p_record_id is null or p_record_id = tenant.tenant_id)
    and (
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      ) is not null
      or exists (
        select 1
        from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = actor_identity_id
          and assignment.revoked_at is null
          and assignment.starts_at <= evaluated_at
          and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
      )
    )
  order by tenant.tenant_id;
end
$function$;

revoke all on function vortex_identity.list_tenants_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenants_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenants_projection(uuid, integer) is
  'Registered tenant projection: returns every active tenant the current viewer''s effective structural administrator assignment already lists, the exact rule the tenant launcher applies, with the organisation the record is read in, the tenant identity, the tenant revision and the safe projected attribute values keyed by lowercase field key, or no row when the viewer has no effective assignment. Capability and change evidence is never projected.';

alter function vortex_identity.list_tenants_projection(uuid,integer) owner to postgres;

-- Canonical source: vortex_identity.provision_tenant.
create or replace function vortex_identity.provision_tenant(
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_short_name text,
  p_tenant_display_name text,
  p_organization_short_name text,
  p_organization_display_name text,
  p_tenant_steward_identity_id uuid,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  root_organization_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_tenant_id uuid := pg_catalog.gen_random_uuid();
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_tenant_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_tenant_id uuid;
  replay_organization_id uuid;
  replay_assignment_id uuid;
  replay_account_id uuid;
begin
  if not vortex_context.is_non_nil_uuid(p_cluster_id::text)
    or not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant provisioning input is invalid';
  end if;

  -- The new tenant has no row to lock yet. This lock is limited to one trusted
  -- actor/cluster/duplicate tuple and exists only to converge simultaneous retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|provision_tenant|' ||
      p_duplicate_key::text,
    30
  ));

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.cluster_id = p_cluster_id
    and stored.operation_key = 'provision_tenant'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select tenant.tenant_id into replay_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(receipt.subject_ids);
    select organization.organization_id into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(receipt.subject_ids);
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(receipt.subject_ids);
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(receipt.subject_ids);
    if replay_tenant_id is null or replay_organization_id is null
      or replay_assignment_id is null or replay_account_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'provision_tenant'::text,
      replay_tenant_id, replay_organization_id, replay_assignment_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, replay_assignment_id)],
      replay_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, replay_account_id)],
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, replay_organization_id)],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  -- Reuse the same #430 language/time-zone validators for account preferences.
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  begin
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by,
      state_changed_at, revision
    ) values (
      new_tenant_id, p_tenant_short_name, p_tenant_display_name, 'active',
      operation_at, p_operator_actor_id, operation_at, 1
    );
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, new_tenant_id, null, p_organization_short_name,
      p_organization_display_name, 'active', operation_at,
      p_operator_actor_id, operation_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (p_tenant_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1),
    (p_organization_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1)
  on conflict on constraint identity_projections_pk do nothing;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id in (
      p_tenant_steward_identity_id, p_organization_steward_identity_id
    ) and projection.state = 'active'
  order by projection.identity_id
  for update;
  if (select pg_catalog.count(distinct projection.identity_id)
      from vortex_identity.identity_projections as projection
      where projection.identity_id in (
        p_tenant_steward_identity_id, p_organization_steward_identity_id
      ) and projection.state = 'active') <>
     (select pg_catalog.count(distinct identity_id)
      from (values (p_tenant_steward_identity_id),
                   (p_organization_steward_identity_id)) as nominated(identity_id)) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    operation_at, operation_at, operation_at, p_operator_actor_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_tenant_assignment_id, new_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select adopted.access_version into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, p_operator_actor_id,
    new_correlation_id
  ) as adopted;

  -- #33 queues this evidence trigger. Validate it while the privileged boundary
  -- is still active so a runtime-role commit cannot bypass or fail its reads.
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    immediate;
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_tenant_id, 1::bigint),
    (new_organization_id, resulting_access_version),
    (new_tenant_assignment_id, 1::bigint),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, cluster_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_cluster_id,
    'provision_tenant', p_duplicate_key, p_command_fingerprint,
    result_subject_ids, result_subject_revisions, operation_at
  );

  return query select 'accepted'::text, 'provision_tenant'::text,
    new_tenant_id, new_organization_id, new_tenant_assignment_id, 1::bigint,
    new_account_id, 1::bigint, resulting_access_version,
    new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text) to vortex_runtime;

comment on function vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations.';

alter function vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text) owner to postgres;

-- Canonical source: vortex_identity.reactivate_cluster_identity.
create or replace function vortex_identity.reactivate_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'reactivate_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_command_fingerprint, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only reactivation of one cluster-local identity projection.';

alter function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.reactivate_tenant.
create or replace function vortex_identity.reactivate_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'reactivate_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_command_fingerprint, p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only reactivation of one stewardship-ready suspended tenant.';

alter function vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.reactivate_tenant_organization.
create or replace function vortex_identity.reactivate_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_parent_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reactivation command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.parent_organization_id,
    organization.revision, organization.state
  into current_parent_id, current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'reactivate_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'suspended' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = current_parent_id;
    if not found or parent_state in ('archived', 'removal_pending') then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  if not exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      where requirement.organization_id = p_organization_id
    )
    or not vortex_access.organization_has_permanent_steward(
      p_organization_id, evaluated_at
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'active',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'reactivate_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'reactivate_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.reactivate_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.read_tenant_organization.
create or replace function vortex_identity.read_tenant_organization(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023', message = 'Tenant organization request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.hierarchy.read',
    pg_catalog.clock_timestamp()
  );
  return query
  select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.read_tenant_organization(uuid, uuid) is
  'Exact same-tenant structural organisation read under the bound request context person''s hierarchy.read capability.';

alter function vortex_identity.read_tenant_organization(uuid,uuid) owner to postgres;

-- Canonical source: vortex_identity.rename_tenant_organization.
create or replace function vortex_identity.rename_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_display_name text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation rename command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.rename',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'rename_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select organization.revision
  into current_revision
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set display_name = p_display_name,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id,
    actor_id,
    tenant_id,
    operation_key,
    duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    accepted_at
  ) values (
    new_correlation_id,
    actor_identity_id,
    p_tenant_id,
    'rename_tenant_organization',
    p_duplicate_key,
    p_command_fingerprint,
    array[p_organization_id],
    array[resulting_revision],
    evaluated_at
  );

  return query
  select 'accepted'::text,
    'rename_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(uuid,text,uuid,uuid,bigint,text) owner to postgres;

-- Canonical source: vortex_identity.reparent_tenant_organization.
create or replace function vortex_identity.reparent_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_parent_organization_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or (
      p_parent_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_parent_organization_id::text)
    ) then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reparent command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.reparent',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'reparent_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reparent_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if p_parent_organization_id = p_organization_id then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if p_parent_organization_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = p_parent_organization_id;
    if not found
      or (
        current_state in ('active', 'suspended')
        and parent_state in ('archived', 'removal_pending')
      ) then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set parent_organization_id = p_parent_organization_id,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id,
    actor_id,
    tenant_id,
    operation_key,
    duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    accepted_at
  ) values (
    new_correlation_id,
    actor_identity_id,
    p_tenant_id,
    'reparent_tenant_organization',
    p_duplicate_key,
    p_command_fingerprint,
    array[p_organization_id],
    array[resulting_revision],
    evaluated_at
  );

  return query
  select 'accepted'::text,
    'reparent_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.reparent_tenant_organization(uuid,text,uuid,uuid,bigint,uuid) owner to postgres;

-- Canonical source: vortex_identity.require_current_tenant_capability.
create or replace function vortex_identity.require_current_tenant_capability(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_capability_key text,
  p_evaluated_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from vortex_identity.tenants as tenant
    join vortex_identity.identity_projections as identity
      on identity.identity_id = p_identity_id
    where tenant.tenant_id = p_tenant_id
      and tenant.state = 'active'
      and identity.state = 'active'
      and (
        vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          identity.identity_id, p_evaluated_at
        ) is not null
        or exists (
          select 1
          from vortex_identity.tenant_administrator_assignments as assignment
          where assignment.tenant_id = tenant.tenant_id
            and assignment.identity_id = identity.identity_id
            and assignment.revoked_at is null
            and assignment.starts_at <= p_evaluated_at
            and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
            and (
              p_capability_key = any(assignment.capability_keys)
              or p_capability_key = 'platform.tenant.capability_limits.read'
            )
        )
      )
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz) is
  'Requires one current tenant capability, the default capability-limits read permission for an active tenant administrator, or the independent active Vortex super-administrator assignment.';

alter function vortex_identity.require_current_tenant_capability(uuid,uuid,text,timestamp with time zone) owner to postgres;

-- Canonical source: vortex_identity.revoke_tenant_administrator.
create or replace function vortex_identity.revoke_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not vortex_identity.tenant_has_permanent_manager(
    p_tenant_id, evaluated_at, p_assignment_id
  ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set revision = resulting_revision, changed_at = evaluated_at,
    changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id, revoked_at = evaluated_at,
    revoked_by_actor_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'revoke_tenant_administrator', p_duplicate_key, p_command_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

alter function vortex_identity.revoke_tenant_administrator(uuid,text,uuid,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.suspend_cluster_identity.
create or replace function vortex_identity.suspend_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'suspend_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_command_fingerprint, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only suspension of one cluster-local identity projection.';

alter function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.suspend_tenant.
create or replace function vortex_identity.suspend_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'suspend_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_command_fingerprint, p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) is 'Configured-system-only non-cascading suspension of one active tenant.';

alter function vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.suspend_tenant_organization.
create or replace function vortex_identity.suspend_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation suspension command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'suspend_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'active' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'suspended',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'suspend_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'suspend_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.suspend_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

-- Canonical source: vortex_identity.tenant_administrator_grant_expiry_cap.
create or replace function vortex_identity.tenant_administrator_grant_expiry_cap(
  p_actor_identity_id uuid,
  p_tenant_id uuid,
  p_capabilities text[],
  p_evaluated_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case when pg_catalog.min(bound.latest_expiry) = 'infinity'::timestamptz
      then null else pg_catalog.min(bound.latest_expiry) end
  from (
    select (
      select pg_catalog.max(coalesce(assignment.expires_at, 'infinity'::timestamptz))
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.identity_id = p_actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= p_evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
        and required.capability_key = any(assignment.capability_keys)
    ) as latest_expiry
    from pg_catalog.unnest(
      pg_catalog.array_append(p_capabilities, 'platform.tenant.administrators.manage')
    ) as required(capability_key)
  ) as bound
$function$;

revoke execute on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) is 'Private: the earliest time the actor loses any of the given tenant capabilities or platform.tenant.administrators.manage, from current assignments; null when none of them expires.';

alter function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.tenant_capabilities_from_json.
create or replace function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb)
returns text[] language plpgsql immutable strict parallel safe security definer set search_path = ''
as $function$
declare result text[];
begin
  if pg_catalog.jsonb_typeof(p_capabilities) <> 'array' then return null; end if;
  select pg_catalog.array_agg(item.value order by item.ordinality) into result
  from pg_catalog.jsonb_array_elements_text(p_capabilities) with ordinality item(value, ordinality);
  if result is null or not vortex_identity.tenant_structural_capability_set_is_canonical(result) then return null; end if;
  return result;
exception when others then return null;
end
$function$;

revoke execute on function vortex_identity.tenant_capabilities_from_json(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_capabilities_from_json(jsonb) is null;

alter function vortex_identity.tenant_capabilities_from_json(jsonb) owner to postgres;

-- Canonical source: vortex_identity.tenant_has_permanent_manager.
create or replace function vortex_identity.tenant_has_permanent_manager(
  p_tenant_id uuid,
  p_checked_at timestamptz,
  p_excluded_assignment_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.tenant_administrator_assignments as assignment
    join vortex_identity.identity_projections as projection
      on projection.identity_id = assignment.identity_id
      and projection.state = 'active'
    where assignment.tenant_id = p_tenant_id
      and assignment.assignment_id is distinct from p_excluded_assignment_id
      and assignment.revoked_at is null
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
      and 'platform.tenant.administrators.manage' = any(assignment.capability_keys)
  )
$function$;

revoke execute on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) is 'Identity-owned current permanent tenant-manager predicate shared by protected tenant operations.';

alter function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) owner to vortex_identity_owner;

-- Canonical source: vortex_identity.tenant_request_actor_id.
create or replace function vortex_identity.tenant_request_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501', message = 'Tenant request actor is unavailable';
  end if;
  perform vortex_identity.require_identity_not_disabled((checked ->> 'identityId')::uuid);
  return (checked ->> 'identityId')::uuid;
end
$function$;

revoke execute on function vortex_identity.tenant_request_actor_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_request_actor_id() is
  'Returns the acting person from the verified request context for tenant governance, or refuses when the bound context names no human or federated person or that person is disabled.';

alter function vortex_identity.tenant_request_actor_id() owner to postgres;

-- Canonical source: vortex_identity.validate_organization_lifecycle.
create or replace function vortex_identity.validate_organization_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_parent_id uuid;
  current_state text;
  tenant_state text;
  parent_state text;
begin
  select organization.parent_organization_id, organization.state
  into current_parent_id, current_state
  from vortex_identity.organizations as organization
  where organization.organization_id = new.organization_id;

  if not found then
    return null;
  end if;

  select tenant.state
  into tenant_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if current_state in ('active', 'suspended')
    and tenant_state in ('archived', 'removal_pending') then
    raise exception using
      errcode = '23514',
      message = 'An unresolved organisation requires a live tenant';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = new.tenant_id
      and parent.organization_id = current_parent_id;

    if current_state in ('active', 'suspended')
      and parent_state in ('archived', 'removal_pending') then
      raise exception using
        errcode = '23514',
        message = 'An unresolved organisation requires a live parent';
    end if;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = new.tenant_id
        and child.parent_organization_id = new.organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending organisation cannot retain unresolved children';
  end if;

  return null;
end
$function$;

revoke execute on function vortex_identity.validate_organization_lifecycle() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.validate_organization_lifecycle() is null;

alter function vortex_identity.validate_organization_lifecycle() owner to vortex_identity_owner;

-- Canonical source: vortex_identity.validate_tenant_lifecycle.
create or replace function vortex_identity.validate_tenant_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_state text;
begin
  select tenant.state
  into current_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if not found then
    return null;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as organization
      where organization.tenant_id = new.tenant_id
        and organization.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending tenant cannot retain unresolved organisations';
  end if;

  return null;
end
$function$;

revoke execute on function vortex_identity.validate_tenant_lifecycle() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.validate_tenant_lifecycle() is null;

alter function vortex_identity.validate_tenant_lifecycle() owner to vortex_identity_owner;

-- Preserve calls from the existing postgres-owned Identity definers.
set local role vortex_identity_owner;
grant execute on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) to postgres;
grant execute on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) to postgres;
reset role;

commit;
