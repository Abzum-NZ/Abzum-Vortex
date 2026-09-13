-- Configured-system provisioning and explicit adoption. These are the only
-- runtime-callable composition points; existing Identity, Access, settings and
-- stewardship owners retain their facts and invariants.

create function vortex_identity.provision_tenant(
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

create function vortex_identity.adopt_tenant(
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

create function vortex_identity.adopt_organization(
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

  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
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

  perform 1 from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id and organization.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;
  select account.revision into account_revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = p_organization_id
    and account.identity_id = p_steward_identity_id
    and account.state = 'active' and projection.state = 'active'
  for update of account, projection;
  if not found then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );

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

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function vortex_identity.adopt_tenant(
  uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function vortex_identity.adopt_organization(
  uuid, uuid, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) to vortex_runtime;
grant execute on function vortex_identity.adopt_tenant(
  uuid, uuid, text, uuid, uuid
) to vortex_runtime;
grant execute on function vortex_identity.adopt_organization(
  uuid, uuid, text, uuid, uuid, uuid, uuid
) to vortex_runtime;

comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations.';
comment on function vortex_identity.adopt_tenant(uuid, uuid, text, uuid, uuid)
  is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';
comment on function vortex_identity.adopt_organization(uuid, uuid, text, uuid, uuid, uuid, uuid)
  is 'Configured-system-only explicit organisation stewardship adoption through the existing Access coordinator.';
