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
