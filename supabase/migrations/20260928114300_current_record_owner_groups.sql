-- Current owner-group choices and initial steward membership for Group-owned records.

create or replace function vortex_access.list_current_record_owner_groups()
returns table (group_id uuid, label text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();

  return query
  select distinct organization_group.group_id, organization_group.label
  from vortex_access.organization_groups as organization_group
  join vortex_access.organization_group_memberships as membership
    on membership.organization_id = organization_group.organization_id
    and membership.group_id = organization_group.group_id
  where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
    and organization_group.state = 'active'
    and membership.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and membership.state = 'live'
    and membership.starts_at <= pg_catalog.statement_timestamp()
    and (membership.expires_at is null
      or membership.expires_at > pg_catalog.statement_timestamp())
  order by organization_group.label, organization_group.group_id;
end
$function$;

revoke all on function vortex_access.list_current_record_owner_groups()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_current_record_owner_groups()
  to vortex_request;

comment on function vortex_access.list_current_record_owner_groups() is
  'Returns only the active Groups of which the verified current organisation account is a current member, for an explicit initial record ownership choice. The protected Record writer rechecks the selected Group under its own transaction lock.';

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
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
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

  -- The first owner needs a real current Group for Group-owned records. Access
  -- owns both facts and their version; no application-specific permission is added.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, operation_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

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

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) to vortex_runtime;
comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations and an initial current owner Group membership for the organisation steward.';

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
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
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

  -- The initial steward has one current Group for Group-owned records.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, evaluated_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

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
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';
