-- Governance changes require recent multi-factor authentication.
-- Managed installations can retain these vendor grants when the migration role cannot revoke them.
do $block$
declare
  relation_name text;
  principal text;
begin
  foreach relation_name in array array['supabase_functions.hooks', 'supabase_functions.migrations'] loop
    foreach principal in array array['anon', 'authenticated'] loop
      begin
        if pg_catalog.has_table_privilege(current_user, relation_name, 'SELECT WITH GRANT OPTION')
          and pg_catalog.has_table_privilege(current_user, relation_name, 'INSERT WITH GRANT OPTION')
          and pg_catalog.has_table_privilege(current_user, relation_name, 'UPDATE WITH GRANT OPTION')
          and pg_catalog.has_table_privilege(current_user, relation_name, 'DELETE WITH GRANT OPTION') then
          execute pg_catalog.format('revoke all privileges on table %s from %I', relation_name, principal);
        end if;
      exception when insufficient_privilege then
        raise notice 'Cannot revoke managed table privileges for % on %', principal, relation_name;
      end;
      if pg_catalog.has_table_privilege(principal, relation_name, 'SELECT, INSERT, UPDATE, DELETE') then
        raise notice 'Managed table privileges remain for % on %', principal, relation_name;
      end if;
    end loop;
  end loop;
  foreach principal in array array['anon', 'authenticated'] loop
    begin
      if pg_catalog.has_schema_privilege(current_user, 'supabase_functions', 'USAGE WITH GRANT OPTION') then
        execute pg_catalog.format('revoke usage on schema supabase_functions from %I', principal);
      end if;
    exception when insufficient_privilege then
      raise notice 'Cannot revoke managed schema usage for %', principal;
    end;
    if pg_catalog.has_schema_privilege(principal, 'supabase_functions', 'USAGE') then
      raise notice 'Managed schema usage remains for %', principal;
    end if;
  end loop;
end
$block$;

set role vortex_owner;

drop function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid);

create or replace function vortex_access.add_organization_group_membership_for_administration(
  p_membership_id uuid,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  membership_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  group_fact vortex_access.organization_groups%rowtype;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  checked_at timestamptz;
  activity_result text;
begin
  p_starts_at := coalesce(p_starts_at, now());

  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership addition input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group membership addition is unavailable';
  end if;

  select organization_group.* into group_fact
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = p_group_id
  for update;
  if not found or group_fact.state <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition is stale or unavailable';
  end if;

  authority_after := vortex_access.organization_group_reduction_authority(
    context_organization_id, p_group_id
  );
  authority_requirement := case authority_after ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object('kind', 'none'),
      'after', authority_after
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.group_memberships.add',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.group_memberships.add'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'add_group_membership',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group membership addition refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.group_memberships.add'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group membership addition is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', context_organization_id, p_membership_id,
    null, p_group_id, p_organization_account_id, p_starts_at, p_expires_at,
    null, context_account_id, context_correlation_id
  ) as result;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'add_group_membership',
    array[p_membership_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs add_membership after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.add_organization_group_membership_for_administration(p_membership_id uuid, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.add_organization_group_membership_for_administration(p_membership_id uuid, p_group_id uuid, p_organization_account_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;


drop function vortex_access.appoint_organization_steward_for_administration(uuid, bigint);

create or replace function vortex_access.appoint_organization_steward_for_administration(
  p_organization_account_id uuid,
  p_expected_account_revision bigint
)
returns table (
  outcome text,
  organization_id uuid,
  appointment_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  platform_owner_id uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_channel text;
  locked_access_version bigint;
  stewardship_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_account vortex_identity.organization_accounts%rowtype;
  steward_role vortex_access.organization_roles%rowtype;
  steward_role_revision vortex_access.organization_role_revisions%rowtype;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  decision record;
  role_decision record;
  version_change record;
  affected_permissions jsonb;
  guarded_minimum jsonb;
  current_guarded_minimum jsonb;
  catalogue_declaration jsonb;
  existing_steward_role_id uuid;
  existing_role_assignment_id uuid;
  existing_delegation_authority_id uuid;
  steward_role_is_qualified boolean;
  generated_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  generated_delegation_authority_id uuid := pg_catalog.gen_random_uuid();
  activity_id uuid;
  activity_result text;
  appointment_starts_at timestamptz;
  authorization_checked_at timestamptz;
  result_summary jsonb;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_account_revision is null
    or p_expected_account_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization steward appointment input is invalid';
  end if;

  platform_owner_id := (vortex_access.required_platform_permission('platform.organization.assignments.manage') ->> 'ownerId')::uuid;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_channel := vortex_platform.channel();

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select requirement.* into stewardship_requirement
  from vortex_access.organization_stewardship_requirements as requirement
  where requirement.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  catalogue_declaration := pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    );
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null
    or decision.valid_until is null
    or decision.checked_at > pg_catalog.clock_timestamp()
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or decision.valid_until <= decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  select account.* into target_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_id = context_organization_id
    and account.organization_account_id = p_organization_account_id
    and account.state = 'active'
    and identity.state = 'active'
  for update of account, identity;
  if not found or p_organization_account_id = context_account_id then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, appointment_starts_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  -- Match the target against the same live minimum used by the permanent-steward
  -- safeguard. The original adoption role may have changed or another role may
  -- already qualify the target.
  with required_declaration as materialized (
    select declaration.permission_id, declaration.meaning_fingerprint
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint,
      registration.revision as registration_revision
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = registration.organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
      and required.meaning_fingerprint = entry.meaning_fingerprint
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        platform_owner_id
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        context_organization_id, registration.revision
      )
      and entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = platform_owner_id
  ), qualifying_role as (
    select role.role_id
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = context_organization_id
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
      and (select pg_catalog.count(*) from required_declaration) > 0
      and (select pg_catalog.count(distinct permission_id) from required_declaration)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(distinct permission_id) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(*) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and not exists (
        select 1 from required_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.meaning_fingerprint = permission.meaning_fingerprint
            and continuity.last_processed_registration_revision = required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
            and permission.meaning_fingerprint = required.meaning_fingerprint
        )
      )
  ), current_steward as (
    select assignment.role_assignment_id,
      delegation.delegation_authority_id, role.role_id
    from vortex_access.organization_role_assignments as assignment
    join qualifying_role as role on role.role_id = assignment.role_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = assignment.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = p_organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= appointment_starts_at
      and delegation.expires_at is null
    where assignment.organization_id = context_organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= appointment_starts_at
      and assignment.expires_at is null
    order by assignment.role_assignment_id, delegation.delegation_authority_id
    limit 1
  )
  select exists (
      select 1 from qualifying_role as role
      where role.role_id = stewardship_requirement.original_role_id
    ), current_steward_result.role_assignment_id,
    current_steward_result.delegation_authority_id,
    current_steward_result.role_id,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'permissionId', declaration.permission_id,
      'meaningFingerprint', declaration.meaning_fingerprint
    ) order by declaration.permission_id) from required_declaration as declaration)
  into steward_role_is_qualified, existing_role_assignment_id,
    existing_delegation_authority_id, existing_steward_role_id, guarded_minimum
  from (select 1) as anchor
  left join current_steward as current_steward_result on true;
  if existing_role_assignment_id is null and steward_role_is_qualified is not true then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select role.* into steward_role
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = coalesce(
      existing_steward_role_id, stewardship_requirement.original_role_id
    )
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select revision.* into steward_role_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = steward_role.role_id
    and revision.revision = steward_role.live_revision
  for share;
  if not found
    or steward_role_revision.lifecycle is distinct from 'active'
    or steward_role_revision.assignment_policy is distinct from 'standing' then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Bind the complete role grant, including every permission beyond the minimum.
  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind, 'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision,
        'meaningFingerprint', permission.meaning_fingerprint
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = steward_role.role_id
      and permission.role_revision = steward_role.live_revision
  ) as reference;
  if affected_permissions is null then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Refresh catalogue authority under all initial locks, without changing context.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  select evaluated.* into strict role_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        )
      )
    )
  ) as evaluated;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null or decision.valid_until is null
    or decision.checked_at > authorization_checked_at
    or decision.valid_until <= authorization_checked_at
    or decision.valid_until <= decision.checked_at
    or role_decision.outcome is distinct from 'eligible'
    or role_decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or role_decision.target_kind is distinct from 'organization'
    or role_decision.target_application_root_id is not null
    or role_decision.organization_id is distinct from context_organization_id
    or role_decision.organization_account_id is distinct from context_account_id
    or role_decision.access_version is distinct from context_access_version
    or role_decision.correlation_id is distinct from context_correlation_id
    or role_decision.reason_code is not null
    or role_decision.checked_at is null or role_decision.valid_until is null
    or role_decision.checked_at > authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= role_decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id,
    'meaningFingerprint', declaration.meaning_fingerprint
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or role_decision.valid_until <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  if target_account.revision is distinct from p_expected_account_revision then
    return query select 'conflict'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  if existing_role_assignment_id is not null then
    perform vortex_access.assert_organization_has_permanent_steward(
      context_organization_id
    );
    if vortex_access.validated_human_request_context() is distinct from context_value
      or decision.valid_until <= pg_catalog.clock_timestamp()
      or role_decision.valid_until <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Organization steward appointment is unavailable';
    end if;
    result_summary := pg_catalog.jsonb_build_object(
      'organizationAccountId', p_organization_account_id,
      'roleAssignmentId', existing_role_assignment_id,
      'delegationAuthorityId', existing_delegation_authority_id
    );
    return query select 'unchanged'::text, context_organization_id,
      result_summary, context_access_version, null::text;
    return;
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    context_organization_id, generated_role_assignment_id, steward_role.role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    appointment_starts_at, null, 'live', context_account_id, appointment_starts_at,
    context_correlation_id, context_account_id, appointment_starts_at,
    context_correlation_id, null, null, null
  ) returning * into assignment_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward role grant is stale or unavailable';
  end if;
  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at, revocation_correlation_id
  ) values (
    context_organization_id, generated_delegation_authority_id,
    'organization_account', p_organization_account_id, null,
    'organization_catalogue', null, 1, appointment_starts_at, null, 'live',
    context_account_id, appointment_starts_at, context_correlation_id,
    context_account_id, appointment_starts_at, context_correlation_id, null, null, null
  ) returning * into delegation_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation grant is stale or unavailable';
  end if;

  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, assignment_fact.changed_at,
    'organization_account', context_account_id, 'grant_role_assignment',
    array[assignment_fact.role_assignment_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward role Activity is stale';
  end if;
  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, delegation_fact.changed_at,
    'organization_account', context_account_id, 'grant_delegation',
    array[delegation_fact.delegation_authority_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation Activity is stale';
  end if;

  if not exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      join vortex_access.organization_roles as role
        on role.organization_id = assignment.organization_id
        and role.role_id = assignment.role_id
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      join vortex_access.organization_delegation_authorities as delegation
        on delegation.organization_id = assignment.organization_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = assignment.organization_id
        and account.organization_account_id = assignment.organization_account_id
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
      where assignment.organization_id = context_organization_id
        and assignment.role_assignment_id = generated_role_assignment_id
        and assignment.role_id = stewardship_requirement.original_role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.group_id is null
        and assignment.assignment_kind = 'standing'
        and assignment.revision = 1
        and assignment.state = 'live'
        and assignment.starts_at = appointment_starts_at
        and assignment.expires_at is null
        and assignment.granted_by = context_account_id
        and assignment.granted_at = appointment_starts_at
        and assignment.grant_correlation_id = context_correlation_id
        and assignment.changed_by = context_account_id
        and assignment.changed_at = appointment_starts_at
        and assignment.change_correlation_id = context_correlation_id
        and assignment.revoked_by is null and assignment.revoked_at is null
        and assignment.revocation_correlation_id is null
        and role.live_revision = steward_role.live_revision
        and revision.lifecycle = 'active'
        and revision.assignment_policy = 'standing'
        and delegation.delegation_authority_id = generated_delegation_authority_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = p_organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.bounded_permissions is null
        and delegation.revision = 1
        and delegation.state = 'live'
        and delegation.starts_at = appointment_starts_at
        and delegation.expires_at is null
        and delegation.granted_by = context_account_id
        and delegation.granted_at = appointment_starts_at
        and delegation.grant_correlation_id = context_correlation_id
        and delegation.changed_by = context_account_id
        and delegation.changed_at = appointment_starts_at
        and delegation.change_correlation_id = context_correlation_id
        and delegation.revoked_by is null and delegation.revoked_at is null
        and delegation.revocation_correlation_id is null
        and account.state = 'active'
        and identity.state = 'active'
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(guarded_minimum) as required(value)
          where not exists (
            select 1
            from vortex_access.organization_role_permission_entries as permission
            join vortex_access.permission_continuities as continuity
              on continuity.organization_id = permission.organization_id
              and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
              and continuity.owner_kind = permission.owner_kind
              and continuity.owner_id = permission.owner_id
              and continuity.permission_id = permission.permission_id
              and continuity.state = 'available'
              and continuity.continuity_revision = permission.continuity_revision
              and continuity.meaning_fingerprint = permission.meaning_fingerprint
            join vortex_access.permission_registrations as registration
              on registration.organization_id = permission.organization_id
              and registration.registration_kind = 'platform'
              and registration.registration_owner_id =
                platform_owner_id
              and registration.state = 'active'
              and continuity.last_processed_registration_revision = registration.revision
            join vortex_access.permission_catalogue_entries as entry
              on entry.organization_id = registration.organization_id
              and entry.registration_kind = registration.registration_kind
              and entry.registration_owner_id = registration.registration_owner_id
              and entry.registration_revision = registration.revision
              and entry.application_root_id is null
              and entry.owner_kind = 'platform'
              and entry.owner_id = platform_owner_id
              and entry.permission_id = permission.permission_id
              and entry.meaning_fingerprint = permission.meaning_fingerprint
            where permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = role.live_revision
              and permission.application_root_id is null
              and permission.owner_kind = 'platform'
              and permission.owner_id = platform_owner_id
              and permission.permission_id = (required.value ->> 'permissionId')::uuid
              and permission.meaning_fingerprint = required.value ->> 'meaningFingerprint'
          )
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment result is stale or unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(
    context_organization_id
  );
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id,
    'meaningFingerprint', declaration.meaning_fingerprint
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select changed.* into strict version_change
  from vortex_access.increment_organization_access_version(
    context_organization_id, context_account_id, context_correlation_id,
    'stewardship_changed'
  ) as changed;
  if version_change.organization_id is distinct from context_organization_id
    or version_change.current_version is distinct from context_access_version + 1
    or version_change.changed_by is distinct from context_account_id
    or version_change.change_correlation_id is distinct from context_correlation_id
    or version_change.change_reason is distinct from 'stewardship_changed' then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment version is stale or unavailable';
  end if;
  result_summary := pg_catalog.jsonb_build_object(
    'organizationAccountId', p_organization_account_id,
    'roleAssignmentId', generated_role_assignment_id,
    'delegationAuthorityId', generated_delegation_authority_id
  );
  return query select 'changed'::text, context_organization_id,
    result_summary, version_change.current_version, null::text;
end
$function$;

revoke execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
to vortex_request;

comment on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint) is
  'Verified human request entry: atomically appoints another active same-organisation account to the current steward role and catalogue delegation under the original context with one Access increment, safe target-revision conflict and no public operation binding.';

alter function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) to postgres;


drop function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid);

create or replace function vortex_access.assign_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_assignment_kind text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  existing_assignment_id uuid;
  summary_assignment_id uuid;
  changed_at_value timestamptz;
  changed_access_version bigint;
  checked_at timestamptz;
  activity_result text;
begin
  p_starts_at := coalesce(p_starts_at, now());

  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_assignee_kind is null
    or p_assignee_kind not in ('organization_account', 'group')
    or p_assignment_kind is null
    or p_assignment_kind not in ('standing', 'eligible')
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or (
      p_assignee_kind = 'organization_account'
      and (
        p_organization_account_id is null
        or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_group_id is not null
      )
    )
    or (
      p_assignee_kind = 'group'
      and (
        p_group_id is null
        or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_organization_account_id is not null
      )
    )
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment assignment input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle <> 'acceptance_required'
    and (
      revision_fact.lifecycle <> 'active'
      or not (
        (p_assignment_kind = 'standing' and revision_fact.assignment_policy = 'standing')
        or (
          p_assignment_kind = 'eligible'
          and revision_fact.assignment_policy = 'activation_required'
        )
      )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision,
        'meaningFingerprint', permission.meaning_fingerprint
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = p_role_id
      and permission.role_revision = role_fact.live_revision
  ) as reference;
  if affected_permissions is not null then
    authority_after := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif revision_fact.lifecycle = 'acceptance_required' then
    authority_after := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment authority is stale or unavailable';
  end if;

  authority_requirement := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management',
    'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', authority_after
  );

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment assignment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  -- Named only to a caller already eligible to assign the role, so its lifecycle is not disclosed.
  if revision_fact.lifecycle = 'acceptance_required' then
    raise exception using errcode = 'V3144',
      message = 'Organization role revision requires acceptance before assignment';
  end if;

  -- One live assignment of a role per assignee: the same role assigned again to the same assignee
  -- with an overlapping live period returns the assignment already in force instead of a second row.
  select existing.role_assignment_id into existing_assignment_id
  from vortex_access.organization_role_assignments as existing
  where existing.organization_id = context_organization_id
    and existing.role_id = p_role_id
    and existing.assignee_kind = p_assignee_kind
    and existing.organization_account_id is not distinct from p_organization_account_id
    and existing.group_id is not distinct from p_group_id
    and existing.assignment_kind = p_assignment_kind
    and existing.state = 'live'
    and existing.role_assignment_id <> p_role_assignment_id
    and existing.starts_at < coalesce(p_expires_at, 'infinity'::timestamptz)
    and coalesce(existing.expires_at, 'infinity'::timestamptz) > p_starts_at
  order by existing.starts_at, existing.role_assignment_id
  limit 1;

  if existing_assignment_id is null then
    select result.* into strict changed
    from vortex_access.coordinate_organization_role_assignment_change(
      'grant', context_organization_id, p_role_assignment_id, null,
      p_role_id, p_expected_role_revision, p_assignee_kind,
      p_organization_account_id, p_group_id, p_assignment_kind,
      p_starts_at, p_expires_at, context_account_id, context_correlation_id
    ) as result;
    summary_assignment_id := p_role_assignment_id;
    changed_at_value := changed.changed_at;
    changed_access_version := changed.access_version;
  else
    summary_assignment_id := existing_assignment_id;
    changed_at_value := pg_catalog.clock_timestamp();
    changed_access_version := context_access_version;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = summary_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed_at_value,
    'organization_account', context_account_id,
    case when existing_assignment_id is null
      then 'grant_role_assignment' else 'role_already_assigned' end,
    array[summary_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, text, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs grant_role_assignment after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;


create or replace function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  candidate jsonb;
  operation_name text;
  operation_key text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  policy_choice jsonb;
  policy_changed boolean;
  decision record;
  changed record;
  activity_result text;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate')
      is distinct from 'object'
    or vortex_platform.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;

  candidate := p_prepared_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId')
      is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'roleId') then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if exists (
      select 1 from vortex_access.organization_roles as stored
      where stored.organization_id = context_organization_id
        and stored.role_id = target_role_id
    ) then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    if pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
        is distinct from 'number'
      or (candidate ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (candidate ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    expected_role_revision :=
      (candidate ->> 'expectedRoleRevision')::numeric::bigint;
    select identity.* into role_identity
    from vortex_access.organization_roles as identity
    where identity.organization_id = context_organization_id
      and identity.role_id = target_role_id
    for update of identity;
    if not found or role_identity.live_revision is distinct from expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := vortex_access.private_current_role_management_scope(
      context_organization_id, target_role_id, expected_role_revision
    );
  end if;

  -- Installation acceptance changes the supplied permissions, never the organization's local
  -- role settings. Compare the complete policy choice, including the immutable activation-policy
  -- revision, under the same Access lock as the write. Changing settings uses role management.
  if operation_name = 'accept_application_role_revision' and (
    candidate -> 'key' is distinct from pg_catalog.to_jsonb(current_revision.role_key)
    or candidate -> 'label' is distinct from pg_catalog.to_jsonb(current_revision.label)
    or candidate -> 'description' is distinct from pg_catalog.to_jsonb(current_revision.description)
    or candidate -> 'privilegeClassification' is distinct from
      pg_catalog.to_jsonb(current_revision.privilege_classification)
    or candidate -> 'assignmentPolicy' is distinct from case current_revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', current_revision.activation_policy_id,
            'revision', current_revision.activation_policy_revision
          )
        )
      )
    end
  ) then
    raise exception using errcode = 'V3151',
      message = 'Accepting application role changes must keep the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.';
  end if;

  if operation_name = 'revise_metadata_policy' then
    policy_choice := candidate -> 'assignmentPolicy';
    if pg_catalog.jsonb_typeof(policy_choice) is distinct from 'object'
      or pg_catalog.jsonb_typeof(policy_choice -> 'kind') is distinct from 'string'
      or policy_choice ->> 'kind' not in ('standing', 'activation_required') then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_choice ->> 'kind' = 'standing' then
      policy_changed := current_revision.assignment_policy <> 'standing';
    elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
      policy_changed := true;
    elsif policy_choice #>> '{activationPolicy,selection}' = 'existing'
      and vortex_platform.is_non_nil_uuid(
        policy_choice #>> '{activationPolicy,reference,activationPolicyId}'
      )
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,revision}'
      ) = 'number'
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric between
        1 and 9007199254740991
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric =
        pg_catalog.trunc((policy_choice #>>
          '{activationPolicy,reference,revision}')::numeric) then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint;
    else
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_changed is not true then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority candidate changes no authority';
    end if;
    authority_after := authority_before;
  else
    authority_after := vortex_access.private_management_scope_from_permission(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  -- Accepting an application's role template or role revision is part of installing or upgrading
  -- that application, so it needs the installation permission (Manage applications) instead of
  -- role management; the delegated scope over every permission and the recent sign-in stay.
  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', case
          when operation_name in ('accept_new_application_role', 'accept_application_role_revision')
            then vortex_access.platform_permission_id('platform.organization.applications.manage')
          else vortex_access.platform_permission_id('platform.organization.roles.manage')
        end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object(
        'kind', 'multi_factor', 'maximumAgeSeconds', 3600
      ),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if decision.outcome = 'refused' and decision.reason_code = 'multi_factor_unsatisfied' then
    raise exception using errcode = 'V3152',
      message = 'Organization role-authority change requires multi-factor authentication';
  end if;
  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Organization role-authority change requires recent primary authentication';
  end if;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
end
$function$;

revoke execute on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid) is
  'Owner-only authority-establishing role composition. It checks exact current/candidate permission scope, then reuses canonical role evidence, manifests, stewardship and Activity without exposing a grant endpoint.';

alter function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) to postgres;


drop function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid);

create or replace function vortex_access.create_organization_group_for_administration(
  p_group_id uuid,
  p_group_key text,
  p_label text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  group_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_key is null
    or pg_catalog.char_length(p_group_key) not between 1 and 40
    or p_group_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_label is null
    or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group creation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group creation is unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and (
        organization_group.group_id = p_group_id
        or organization_group.group_key = p_group_key
      )
  ) then
    raise exception using errcode = '40001',
      message = 'Organization Group creation is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.groups.create',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.groups.create'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'create_group',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group creation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.groups.create'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group creation is unavailable';
  end if;

  select group_change.* into strict changed
  from vortex_access.coordinate_organization_group_change(
    'create_group', context_organization_id, p_group_id, null,
    p_group_key, p_label, context_account_id, context_correlation_id
  ) as group_change;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'create_group',
    array[p_group_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group creation Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id, 'key', changed.group_key,
      'label', changed.label, 'state', changed.state,
      'revision', changed.revision
    ), changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid)
to vortex_request;

comment on function vortex_access.create_organization_group_for_administration(uuid, text, text, uuid) is
  'Standalone request entry: creates one empty Group after fixed teams-manage authorization, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.create_organization_group_for_administration(p_group_id uuid, p_group_key text, p_label text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.create_organization_group_for_administration(p_group_id uuid, p_group_key text, p_label text, p_activity_id uuid) to postgres;


drop function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid);

create or replace function vortex_access.deactivate_organization_role_activation_for_administration(
  p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, activation_summary jsonb, access_version bigint, refusal_reason text)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid;
  locked_access_version bigint; activation_fact vortex_access.organization_role_activations%rowtype;
  affected_permissions jsonb; decision record; changed record; summary jsonb;
  activity_result text;
begin
  if p_role_activation_id is null or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_activation_revision is null or p_expected_activation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Role activation deactivation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Role activation deactivation is unavailable';
  end if;
  select activation.* into activation_fact
  from vortex_access.organization_role_activations as activation
  where activation.organization_id = context_organization_id
    and activation.role_activation_id = p_role_activation_id for update;
  if not found or activation_fact.revision <> p_expected_activation_revision
    or activation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Role activation deactivation is stale or unavailable';
  end if;
  if activation_fact.organization_account_id <> context_account_id then
    select pg_catalog.jsonb_agg(reference.permission order by reference.application_root_id nulls first,
      reference.owner_kind, reference.owner_id, reference.permission_id) into affected_permissions
    from (select permission.application_root_id, permission.owner_kind, permission.owner_id,
      permission.permission_id, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id, 'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id, 'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision,
        'meaningFingerprint', permission.meaning_fingerprint)) as permission
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = context_organization_id
        and permission.role_id = activation_fact.role_id
        and permission.role_revision = activation_fact.historical_role_revision) as reference;
    if affected_permissions is null then
      raise exception using errcode = '40001', message = 'Role activation historical scope is unavailable';
    end if;
    select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object('operationKey', 'platform.organization.role_activations.revoke',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
        'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', affected_permissions),
          'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
    if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_activations.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_role_activation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Role activation deactivation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_activations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Role activation deactivation is unavailable';
  end if;
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_role_activation_change(
    'revoke_role_activation', context_organization_id, p_role_activation_id,
    p_expected_activation_revision, null, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_role_activation_summary(context_organization_id, p_role_activation_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed activation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.activation ->> 'changedAt')::timestamptz, 'organization_account',
    context_account_id, 'revoke_role_activation', array[p_role_activation_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Role activation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version, null::text;
end $function$;

revoke execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_activation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid) to postgres;


drop function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid);

create or replace function vortex_access.grant_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid, p_holder_kind text, p_holder_id uuid,
  p_expected_holder_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, delegation_summary jsonb, access_version bigint, refusal_reason text)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid; locked_access_version bigint;
  holder_revision bigint; decision record; changed record; summary jsonb; activity_result text;
begin
  if p_delegation_authority_id is null or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_holder_kind is null or p_holder_kind not in ('organization_account', 'group')
    or p_holder_id is null or p_holder_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_holder_revision is null or p_expected_holder_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Delegation grant input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id and organization.state = 'active'
    and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Delegation grant is unavailable'; end if;

  select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object('operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')))) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001', message = 'Delegation grant refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id, null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501', message = 'Delegation grant is unavailable';
  end if;

  if p_holder_kind = 'organization_account' and p_holder_id = context_account_id then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, pg_catalog.clock_timestamp(),
      'organization_account', context_account_id, 'grant_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001', message = 'Delegation grant refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id, null::jsonb, context_access_version, null::text;
    return;
  end if;
  if p_holder_kind = 'organization_account' then
    select account.revision into holder_revision from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity on identity.identity_id = account.identity_id
    where account.organization_id = context_organization_id
      and account.organization_account_id = p_holder_id and account.state = 'active'
      and identity.state = 'active' for update of account, identity;
  else
    select organization_group.revision into holder_revision from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and organization_group.group_id = p_holder_id and organization_group.state = 'active' for update;
  end if;
  if holder_revision is distinct from p_expected_holder_revision or exists (
    select 1 from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_id and delegation.holder_kind = p_holder_kind
      and (delegation.organization_account_id = p_holder_id or delegation.group_id = p_holder_id)
      and delegation.scope_kind = 'organization_catalogue' and delegation.state = 'live'
      and (delegation.expires_at is null or delegation.expires_at > pg_catalog.clock_timestamp())
  ) then
    raise exception using errcode = '40001', message = 'Delegation holder is stale or already has catalogue authority';
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_delegation_authority_change(
    'grant_delegation', context_organization_id, p_delegation_authority_id, null, p_holder_kind,
    case when p_holder_kind = 'organization_account' then p_holder_id else null end,
    case when p_holder_kind = 'group' then p_holder_id else null end,
    'organization_catalogue', null, pg_catalog.clock_timestamp(), null,
    context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_delegation_summary(context_organization_id, p_delegation_authority_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed delegation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.delegation ->> 'changedAt')::timestamptz, 'organization_account', context_account_id,
    'grant_delegation', array[p_delegation_authority_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Delegation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version, null::text;
end $function$;

alter function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid) owner to vortex_owner;
revoke execute on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid)
to vortex_request, postgres;
comment on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid) is
  'Grants catalogue delegation to an active person or Group through delegated management; grants no role or Studio permission. Existing delegation revocation removes the authority.';


create or replace function vortex_access.organization_accounts_administration_change_scope() RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare decision record; resolved_tenant_id uuid;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.accounts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.accounts.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome = 'refused' and decision.reason_code = 'multi_factor_unsatisfied' then
    raise exception using errcode = 'V3152',
      message = 'Organization account administration requires multi-factor authentication';
  end if;
  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Organization account administration requires recent authentication';
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.accounts.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization account administration change is unavailable';
  end if;
  select organization.tenant_id into strict resolved_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = decision.organization_id;
  return query select resolved_tenant_id, decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

alter function vortex_access.organization_accounts_administration_change_scope() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.organization_accounts_administration_change_scope() IS 'Private fixed accounts.manage decision for organisation-local account lifecycle.';

REVOKE ALL ON FUNCTION vortex_access.organization_accounts_administration_change_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_accounts_administration_change_scope() to postgres;


create or replace function vortex_access.organization_invitations_administration_change_scope() RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare decision record; resolved_tenant_id uuid;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.invitations.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.invitations.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.invitations.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization invitation administration change is unavailable';
  end if;
  select organization.tenant_id into strict resolved_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = decision.organization_id;
  return query select resolved_tenant_id, decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

alter function vortex_access.organization_invitations_administration_change_scope() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.organization_invitations_administration_change_scope() IS 'Private fixed invitations.manage decision for no-intent invitation changes.';

REVOKE ALL ON FUNCTION vortex_access.organization_invitations_administration_change_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_invitations_administration_change_scope() to postgres;


drop function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid);

create or replace function vortex_access.remove_organization_group_membership_for_administration(
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  membership_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  authority_before jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_membership_revision is null
    or p_expected_membership_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership removal input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group membership removal is unavailable';
  end if;

  select membership.* into membership_fact
  from vortex_access.organization_group_memberships as membership
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id
  for update;
  if not found or membership_fact.revision <> p_expected_membership_revision
    or membership_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership removal is stale or unavailable';
  end if;

  perform 1
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = membership_fact.group_id
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization Group membership source is unavailable';
  end if;

  authority_before := vortex_access.organization_group_reduction_authority(
    context_organization_id, membership_fact.group_id
  );
  authority_requirement := case authority_before ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', authority_before,
      'after', pg_catalog.jsonb_build_object('kind', 'none')
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.group_memberships.remove',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.group_memberships.remove'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'remove_group_membership',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group membership removal refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.group_memberships.remove'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group membership removal is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    'remove_membership', context_organization_id, p_membership_id,
    p_expected_membership_revision, null, null, null, null, null,
    context_account_id, context_correlation_id
  ) as result;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'remove_group_membership',
    array[p_membership_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership removal Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs remove_group_membership after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.remove_organization_group_membership_for_administration(p_membership_id uuid, p_expected_membership_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.remove_organization_group_membership_for_administration(p_membership_id uuid, p_expected_membership_revision bigint, p_activity_id uuid) to postgres;


drop function vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid);

create or replace function vortex_access.rename_organization_group_for_administration(
  p_group_id uuid,
  p_expected_group_revision bigint,
  p_label text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  group_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  group_fact vortex_access.organization_groups%rowtype;
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_group_revision is null
    or p_expected_group_revision not between 1 and 9007199254740991
    or p_label is null
    or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group label revision input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group label revision is unavailable';
  end if;

  select organization_group.* into group_fact
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = p_group_id
  for update;
  if not found or group_fact.revision <> p_expected_group_revision
    or group_fact.state <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization Group change is stale or unavailable';
  end if;
  if group_fact.label is not distinct from p_label then
    raise exception using errcode = '40001',
      message = 'Organization Group label is unchanged';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.groups.rename',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.groups.rename'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revise_group_label',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group label revision refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.groups.rename'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group label revision is unavailable';
  end if;

  select group_change.* into strict changed
  from vortex_access.coordinate_organization_group_change(
    'revise_group_label', context_organization_id, p_group_id,
    p_expected_group_revision, null, p_label,
    context_account_id, context_correlation_id
  ) as group_change;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'revise_group_label',
    array[p_group_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group label revision Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id, 'key', changed.group_key,
      'label', changed.label, 'state', changed.state,
      'revision', changed.revision
    ), changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid)
to vortex_request;

comment on function vortex_access.rename_organization_group_for_administration(uuid, bigint, text, uuid) is
  'Standalone request entry: revises one Group label after fixed teams-manage authorization, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.rename_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_label text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.rename_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_label text, p_activity_id uuid) to postgres;


drop function vortex_access.retire_organization_group_for_administration(uuid, bigint, uuid);

create or replace function vortex_access.retire_organization_group_for_administration(
  p_group_id uuid,
  p_expected_group_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  group_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  group_fact vortex_access.organization_groups%rowtype;
  authority_before jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  activity_result text;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_group_revision is null
    or p_expected_group_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group retirement input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group retirement is unavailable';
  end if;

  select organization_group.* into group_fact
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = p_group_id
  for update;
  if not found or group_fact.revision <> p_expected_group_revision
    or group_fact.state <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization Group retirement is stale or unavailable';
  end if;

  authority_before := vortex_access.organization_group_reduction_authority(
    context_organization_id, p_group_id
  );
  authority_requirement := case authority_before ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', authority_before,
      'after', pg_catalog.jsonb_build_object('kind', 'none')
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.groups.retire',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.groups.retire'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'retire_group',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group retirement refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.groups.retire'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group retirement is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_change(
    'retire_group', context_organization_id, p_group_id,
    p_expected_group_revision, null, null,
    context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'retire_group',
    array[p_group_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group retirement Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id,
    pg_catalog.jsonb_build_object(
      'groupId', changed.group_id, 'key', changed.group_key,
      'label', changed.label, 'state', changed.state,
      'revision', changed.revision
    ), changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.retire_organization_group_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.retire_organization_group_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.retire_organization_group_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs retire_group after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.retire_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.retire_organization_group_for_administration(p_group_id uuid, p_expected_group_revision bigint, p_activity_id uuid) to postgres;


drop function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid);

create or replace function vortex_access.retire_organization_role_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_prepared_role_change jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  expected_candidate jsonb;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_prepared_role_change is null
    or pg_catalog.jsonb_typeof(p_prepared_role_change) is distinct from 'object'
    or p_prepared_role_change - array['contractVersion', 'candidate']::text[] <> '{}'::jsonb
    or not (p_prepared_role_change ?& array['contractVersion', 'candidate'])
    or p_prepared_role_change ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_prepared_role_change -> 'candidate')
      is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role retirement input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role retirement is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement is stale or unavailable';
  end if;

  expected_candidate := pg_catalog.jsonb_build_object(
    'operation', 'retire_role',
    'organizationId', context_organization_id,
    'roleId', p_role_id,
    'expectedRoleRevision', p_expected_role_revision
  );
  if p_prepared_role_change -> 'candidate' is distinct from expected_candidate then
    raise exception using errcode = '40001',
      message = 'Prepared organization role retirement is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision,
      'meaningFingerprint', permission.meaning_fingerprint
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null
    and revision_fact.lifecycle not in ('unavailable', 'acceptance_required')
    and exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = p_role_id
        and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case
    when affected_permissions is not null
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    when revision_fact.lifecycle in ('unavailable', 'acceptance_required')
      and exists (
        select 1
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = context_organization_id
          and assignment.role_id = p_role_id
          and assignment.state = 'live'
      )
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    else pg_catalog.jsonb_build_object('kind', 'permission')
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.retire',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.retire'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'retire_role',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role retirement refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.retire'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role retirement is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_role_change, context_account_id, context_correlation_id
  ) as result;
  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'retire_role',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role retirement Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid)
to vortex_request;

comment on function vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid) is
  'Standalone request entry: performs retire_role after fixed protected checks; a zero-entry unavailable or acceptance_required role with live assignments uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.retire_organization_role_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_prepared_role_change jsonb, p_activity_id uuid) to postgres;


drop function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid);

create or replace function vortex_access.revise_organization_role_metadata_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_label text,
  p_description text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed_summary jsonb;
  operation_at timestamptz;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_label is null or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_description is null or p_description <> pg_catalog.btrim(p_description)
    or pg_catalog.char_length(p_description) not between 1 and 1000
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role metadata revision input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision,
      'meaningFingerprint', permission.meaning_fingerprint
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null and exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = context_organization_id
      and assignment.role_id = p_role_id
      and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case when affected_permissions is null
    then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      ),
      'after', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      )
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.revise_metadata',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.revise_metadata'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revise_role_metadata',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role metadata revision refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.revise_metadata'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  if role_fact.live_revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role revision is exhausted';
  end if;
  if revision_fact.label is not distinct from p_label
    and revision_fact.description is not distinct from p_description then
    raise exception using errcode = '40001',
      message = 'Organization role label and description are unchanged';
  end if;

  -- A label or description edit changes no permission, assignment policy,
  -- lifecycle or source fact, so it appends one revision that carries every
  -- other fact forward and leaves the Access version untouched.
  operation_at := greatest(
    revision_fact.changed_at, pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select permission.organization_id, permission.role_id,
    role_fact.live_revision + 1, permission.entry_ordinal, permission.role_kind,
    permission.role_application_root_id, permission.application_root_id,
    permission.owner_kind, permission.owner_id, permission.permission_id,
    permission.registration_kind, permission.registration_owner_id,
    permission.accepted_registration_revision, permission.catalogue_fingerprint,
    permission.continuity_revision, permission.meaning_fingerprint
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision
  order by permission.entry_ordinal;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    context_organization_id, p_role_id, role_fact.live_revision + 1,
    revision_fact.role_kind, revision_fact.application_root_id,
    revision_fact.lifecycle, revision_fact.privilege_classification,
    revision_fact.assignment_policy, revision_fact.policy_continuity_revision,
    revision_fact.authority_continuity_revision,
    revision_fact.activation_policy_id, revision_fact.activation_policy_revision,
    revision_fact.role_key,
    p_label, p_description, revision_fact.source_definition_key,
    revision_fact.source_release_revision, revision_fact.source_release_version,
    revision_fact.source_validation_contract_version,
    revision_fact.accepted_registration_revision,
    revision_fact.template_continuity_revision,
    context_account_id, operation_at, context_correlation_id
  );

  update vortex_access.organization_roles as stored
  set live_revision = role_fact.live_revision + 1
  where stored.organization_id = context_organization_id
    and stored.role_id = p_role_id
    and stored.live_revision = p_expected_role_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization role revision changed concurrently';
  end if;

  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    operation_at,
    'organization_account', context_account_id, 'revise_role_metadata',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    context_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
to vortex_request;

comment on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid) is
  'Standalone request entry: performs a display-only role label and description revision after fixed protected checks without advancing the Access version, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) to postgres;


create or replace function vortex_access.revoke_capability_policy_ceiling(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context_value jsonb;
  actor_kind_value text := 'platform_operator';
  actor_id_value uuid := p_operator_actor_id;
  source_value text := 'system';
  actor_identity_id uuid;
  active_assignment_id uuid;
  target vortex_access.capability_policy_assignments%rowtype;
  stored record; claimed jsonb;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Capability ceiling revocation is invalid';
  end if;
  if p_operator_actor_id is not null then
    -- The configured system operator remains a context-free bootstrap caller.
    perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  else
    context_value := vortex_access.validated_human_request_context();
    actor_identity_id := (context_value ->> 'identityId')::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
    );
    perform 1
    from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id
      and identity.state = 'active'
    for share;
    if not found then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    evaluated_at := pg_catalog.clock_timestamp();
    active_assignment_id :=
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      );
    if active_assignment_id is null then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    if vortex_access.recent_authentication_deadline_internal(
      context_value, evaluated_at,
      '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
    ) is null then
      raise exception using errcode = 'V3152',
        message = 'Multi-factor authentication is required for capability ceiling changes';
    end if;
    actor_kind_value := 'identity';
    actor_id_value := actor_identity_id;
    source_value := coalesce(context_value ->> 'channel', 'web');
    correlation := (context_value ->> 'correlationId')::uuid;
  end if;
  if actor_kind_value = 'identity' then
    -- The selected organisation is only the request anchor. The target tenant
    -- is independently checked and may have no active organisation.
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
    for no key update;
  else
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id
    for no key update;
  end if;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text), 'UTF8'),
    'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the ceiling it already revoked.
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_capability_policy_ceiling', p_duplicate_key, null,
    p_tenant_id, actor_id_value, 'Capability ceiling revocation duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability ceiling revocation duplicate conflicts';
    end if;
    select change.* into evidence
    from vortex_access.capability_limit_changes as change
    where change.change_id = stored."receiptId";
    if not found
      or evidence.actor_kind is distinct from actor_kind_value
      or evidence.actor_id is distinct from actor_id_value
      or evidence.tenant_id is distinct from p_tenant_id
      or evidence.assignment_id is distinct from p_assignment_id
      or evidence.assignment_revision is distinct from stored."subjectRevisions"[1]
      or evidence.change_kind is distinct from 'ceiling_revoked'
      or evidence.correlation_id is distinct from stored."receiptId" then
      raise exception using errcode = '42501',
        message = 'Capability ceiling revocation replay is unavailable';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id,
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;
  select assignment.* into target
  from vortex_access.capability_policy_assignments as assignment
  where assignment.assignment_id = p_assignment_id for update;
  if not found or target.tenant_id <> p_tenant_id or target.assignment_kind <> 'ceiling' then
    raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
  end if;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability ceiling is stale';
  end if;
  update vortex_access.capability_policy_assignments as assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = actor_id_value, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = actor_id_value,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[(p_expected_revision + 1)::bigint]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null, 'ceiling_revoked', actor_kind_value, actor_id_value,
    target.policy_id, target.policy_revision, p_assignment_id, p_expected_revision + 1,
    target.capability_key, target.unit, null, null, source_value, correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id,
    p_expected_revision + 1, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) to vortex_runtime, vortex_request;

comment on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) is
  'Revokes a tenant capability ceiling. The configured system operator retains its context-free bootstrap path; an active named Vortex super administrator may act as a verified person with recent primary authentication, using the selected organisation only as an account-bound request anchor and independently checking an active target tenant. Both paths write an accepted receipt and append-only change evidence; allocations beneath the ceiling stop applying.';

alter function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;


drop function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid);

create or replace function vortex_access.revoke_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, delegation_summary jsonb, access_version bigint, refusal_reason text)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid; locked_access_version bigint;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  authority_before jsonb; decision record; changed record; summary jsonb; activity_result text;
begin
  if p_delegation_authority_id is null or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_delegation_revision is null or p_expected_delegation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Delegation revocation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id and organization.state = 'active'
    and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Delegation revocation is unavailable'; end if;
  select delegation.* into delegation_fact from vortex_access.organization_delegation_authorities as delegation
  where delegation.organization_id = context_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id for update;
  if not found or delegation_fact.revision <> p_expected_delegation_revision or delegation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Delegation revocation is stale or unavailable'; end if;
  if delegation_fact.scope_kind = 'organization_catalogue' then
    authority_before := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    select pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions',
      pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'applicationRootId', permission.value -> 'applicationRootId',
          'ownerKind', permission.value -> 'ownerKind',
          'ownerId', permission.value -> 'ownerId',
          'permissionId', permission.value -> 'permissionId',
          'acceptedRegistrationRevision', permission.value -> 'acceptedRegistrationRevision',
          'meaningFingerprint', permission.value -> 'meaningFingerprint'))))
    into authority_before
    from pg_catalog.jsonb_array_elements(delegation_fact.bounded_permissions)
      as permission(value);
  end if;
  select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object('operationKey', 'platform.organization.delegations.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
        'before', authority_before, 'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Delegation revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Delegation revocation is unavailable';
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_delegation_authority_change(
    'revoke_delegation', context_organization_id, p_delegation_authority_id,
    p_expected_delegation_revision, null, null, null, null, null, null, null,
    context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_delegation_summary(context_organization_id, p_delegation_authority_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed delegation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.delegation ->> 'changedAt')::timestamptz, 'organization_account', context_account_id,
    'revoke_delegation', array[p_delegation_authority_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Delegation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version, null::text;
end $function$;

revoke execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_delegation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid) to postgres;


drop function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid);

create or replace function vortex_access.revoke_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  current_role_revision bigint;
  current_role_lifecycle text;
  affected_permissions jsonb;
  affected_authority jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
  for update;
  if not found
    or assignment_fact.revision <> p_expected_assignment_revision
    or assignment_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation is stale or unavailable';
  end if;

  select role.live_revision, revision.lifecycle
    into strict current_role_revision, current_role_lifecycle
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = context_organization_id
    and role.role_id = assignment_fact.role_id;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision,
        'meaningFingerprint', permission.meaning_fingerprint
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = assignment_fact.role_id
      and permission.role_revision = current_role_revision
  ) as reference;
  if affected_permissions is not null then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif current_role_lifecycle in ('unavailable', 'acceptance_required', 'retired') then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'organization_catalogue'
    );
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment authority is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', affected_authority,
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment_change.* into strict changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', context_organization_id, p_role_assignment_id,
    p_expected_assignment_revision, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id
  ) as assignment_change;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'revoke_role_assignment',
    array[p_role_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_assignment after fixed protected checks; a current zero-entry unavailable, acceptance_required or retired role uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) to postgres;


create or replace function vortex_access.set_capability_policy_ceiling(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_expected_revision bigint
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, policy_id uuid, policy_revision bigint,
  capability_key text, unit text, quantity_limit numeric, revision bigint,
  correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context_value jsonb;
  actor_kind_value text := 'platform_operator';
  actor_id_value uuid := p_operator_actor_id;
  source_value text := 'system';
  actor_identity_id uuid;
  active_assignment_id uuid;
  policy vortex_access.capability_policy_definitions%rowtype;
  target vortex_access.capability_policy_assignments%rowtype;
  stored record; claimed jsonb;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990) then
    raise exception using errcode = '22023', message = 'Capability ceiling is invalid';
  end if;
  if p_operator_actor_id is not null then
    -- The configured system operator remains a context-free bootstrap caller.
    perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  else
    context_value := vortex_access.validated_human_request_context();
    actor_identity_id := (context_value ->> 'identityId')::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
    );
    perform 1
    from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id
      and identity.state = 'active'
    for share;
    if not found then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    evaluated_at := pg_catalog.clock_timestamp();
    active_assignment_id :=
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      );
    if active_assignment_id is null then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    if vortex_access.recent_authentication_deadline_internal(
      context_value, evaluated_at,
      '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
    ) is null then
      raise exception using errcode = 'V3152',
        message = 'Multi-factor authentication is required for capability ceiling changes';
    end if;
    actor_kind_value := 'identity';
    actor_id_value := actor_identity_id;
    source_value := coalesce(context_value ->> 'channel', 'web');
    correlation := (context_value ->> 'correlationId')::uuid;
  end if;
  if actor_kind_value = 'identity' then
    -- The selected organisation is only the request anchor. The target tenant
    -- is independently checked and may have no active organisation.
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
    for no key update;
  else
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id
    for no key update;
  end if;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_policy_id::text, p_policy_revision::text,
      p_starts_at::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'set_capability_policy_ceiling', p_duplicate_key, null,
    p_tenant_id, actor_id_value, 'Capability ceiling duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability ceiling duplicate conflicts';
    end if;
    select change.* into evidence
    from vortex_access.capability_limit_changes as change
    where change.change_id = stored."receiptId";
    if not found
      or evidence.actor_kind is distinct from actor_kind_value
      or evidence.actor_id is distinct from actor_id_value
      or evidence.tenant_id is distinct from p_tenant_id
      or evidence.assignment_id is distinct from p_assignment_id
      or evidence.assignment_revision is distinct from stored."subjectRevisions"[1]
      or evidence.change_kind not in ('ceiling_set', 'ceiling_revised')
      or evidence.correlation_id is distinct from stored."receiptId" then
      raise exception using errcode = '42501', message = 'Capability ceiling replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.policy_id, evidence.policy_revision, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.assignment_revision, stored."receiptId",
      stored."acceptedAt";
    return;
  end if;
  select definition.* into policy
  from vortex_access.capability_policy_definitions as definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  if not found then
    raise exception using errcode = 'V3101',
      message = 'Capability policy definition revision is unavailable';
  end if;
  if p_expected_revision is null then
    if exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.assignment_kind = 'ceiling'
        and assignment.capability_key = policy.capability_key
        and assignment.unit = policy.unit and assignment.revoked_at is null
    ) or exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.assignment_id = p_assignment_id
    ) then
      raise exception using errcode = '23505', message = 'Capability ceiling already exists';
    end if;
    resulting_revision := 1;
    insert into vortex_access.capability_policy_assignments(
      assignment_id, tenant_id, organization_id, policy_id, policy_revision,
      capability_key, unit, starts_at, expires_at, revision, assigned_at,
      assigned_by_actor_id, assignment_correlation_id, changed_at,
      changed_by_actor_id, change_correlation_id, assignment_kind, allocated_quantity
    ) values (
      p_assignment_id, p_tenant_id, null, p_policy_id, p_policy_revision,
      policy.capability_key, policy.unit, p_starts_at, p_expires_at, resulting_revision,
      evaluated_at, actor_id_value, correlation, evaluated_at, actor_id_value,
      correlation, 'ceiling', null
    );
  else
    select assignment.* into target
    from vortex_access.capability_policy_assignments as assignment
    where assignment.assignment_id = p_assignment_id for update;
    if not found or target.tenant_id <> p_tenant_id or target.assignment_kind <> 'ceiling' then
      raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
    end if;
    -- A ceiling is re-pinned in place so the tenant is never left without one,
    -- and only to a policy for the same capability and unit.
    if target.capability_key <> policy.capability_key or target.unit <> policy.unit then
      raise exception using errcode = '22023',
        message = 'Capability ceiling scope cannot change';
    end if;
    if target.revoked_at is not null or target.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Capability ceiling is stale';
    end if;
    resulting_revision := p_expected_revision + 1;
    update vortex_access.capability_policy_assignments as assignment
    set policy_id = p_policy_id, policy_revision = p_policy_revision,
        starts_at = p_starts_at, expires_at = p_expires_at, revision = resulting_revision,
        changed_at = evaluated_at, changed_by_actor_id = actor_id_value,
        change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null,
    case when resulting_revision = 1 then 'ceiling_set' else 'ceiling_revised' end,
    actor_kind_value, actor_id_value, p_policy_id, p_policy_revision,
    p_assignment_id, resulting_revision, policy.capability_key, policy.unit,
    policy.quantity_limit, p_expires_at, source_value, correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_policy_id,
    p_policy_revision, policy.capability_key, policy.unit, policy.quantity_limit,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) to vortex_runtime, vortex_request;

comment on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) is
  'Sets or re-pins a tenant capability ceiling to an exact policy revision. The configured system operator retains its context-free bootstrap path; an active named Vortex super administrator may act as a verified person with recent primary authentication, using the selected organisation only as an account-bound request anchor and independently checking an active target tenant. Both paths write an accepted receipt and append-only change evidence.';

alter function vortex_access.set_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_policy_id uuid, p_policy_revision bigint, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.set_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_policy_id uuid, p_policy_revision bigint, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.grant_vortex_super_administrator(
  p_duplicate_key uuid,
  p_identity_id uuid
)
returns table (
  outcome text,
  assignment_id uuid,
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
  context_value jsonb;
  actor_identity_id uuid;
  claimed jsonb;
  active_assignment_id uuid;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  computed_fingerprint text;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator grant command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  select assignment.assignment_id into active_assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  join vortex_identity.identity_projections as identity
    on identity.identity_id = assignment.identity_id
    and identity.state = 'active'
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share of assignment;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator identity is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;

  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant', p_identity_id::text), 'UTF8'),
    'sha256'
  ), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_grant', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator grant duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator grant duplicate conflicts';
    end if;
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      p_identity_id, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  if exists (
    select 1
    from vortex_identity.vortex_super_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
      and assignment.revoked_at is null
  ) then
    raise exception using errcode = 'V3141',
      message = 'Identity already has an active super-administrator assignment';
  end if;

  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'fingerprint', computed_fingerprint, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_granted',
    array(
      select subject_id
      from pg_catalog.unnest(array[p_identity_id, new_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.grant_vortex_super_administrator(uuid, uuid) is
  'Grants a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and immutable attribution.';

alter function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.grant_vortex_super_administrator(p_duplicate_key uuid, p_identity_id uuid) to postgres;


create or replace function vortex_identity.revoke_vortex_super_administrator(
  p_duplicate_key uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  assignment_id uuid,
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
  context_value jsonb;
  actor_identity_id uuid;
  target_identity_id uuid;
  claimed jsonb;
  assignment_fact vortex_identity.vortex_super_administrator_assignments%rowtype;
  evaluated_at timestamptz;
  revoked_at_value timestamptz;
  resulting_revision bigint;
  computed_fingerprint text;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_assignment_id is null
    or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Super-administrator revocation command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.assignment_id = p_assignment_id
  for update;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is unavailable';
  end if;
  target_identity_id := assignment_fact.identity_id;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;

  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke',
      p_assignment_id::text, p_expected_revision::text), 'UTF8'), 'sha256'
  ), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_revoke', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator revocation duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      target_identity_id, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  if assignment_fact.revoked_at is not null then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is already revoked';
  end if;
  if assignment_fact.revision <> p_expected_revision
    or assignment_fact.revision = 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Super-administrator assignment revision is stale';
  end if;

  revoked_at_value := evaluated_at;
  resulting_revision := assignment_fact.revision + 1;

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_revoked',
    array(
      select subject_id
      from pg_catalog.unnest(array[target_identity_id, p_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  update vortex_identity.vortex_super_administrator_assignments as assignment
  set revision = resulting_revision,
    changed_at = revoked_at_value,
    changed_by_kind = 'identity',
    changed_by_id = actor_identity_id,
    change_correlation_id = new_correlation_id,
    revoked_at = revoked_at_value,
    revoked_by_kind = 'identity',
    revoked_by_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where assignment.assignment_id = p_assignment_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'fingerprint', computed_fingerprint, 'assignmentId', p_assignment_id, 'revision', resulting_revision,
      'correlationId', new_correlation_id, 'acceptedAt', revoked_at_value
    )
  );

  return query select 'accepted'::text, p_assignment_id, target_identity_id,
    resulting_revision, new_correlation_id, revoked_at_value;
end
$function$;

revoke all on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint) is
  'Revokes a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and exact revision evidence.';

alter function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.revoke_vortex_super_administrator(p_duplicate_key uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;

create or replace function vortex_access.evaluate_organization_permission_eligibility(
  p_declaration jsonb
)
returns table (
  outcome text,
  operation_key text,
  target_kind text,
  target_application_root_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  checked_at timestamptz,
  valid_until timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permission jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  scope_candidate jsonb;
  permission_candidate jsonb;
  scope_name text;
  operation_value text;
  target_kind_value text;
  target_application_value uuid;
  permission_application_value uuid;
  permission_owner_kind_value text;
  authority_kind_value text;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermission',
      'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermission',
        'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permission := p_declaration -> 'requiredPermission';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' not in ('organization', 'application')
    or (
      declaration_target ->> 'kind' = 'organization'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_target ->> 'kind' = 'application'
      and (
        not declaration_target ? 'applicationRootId'
        or not vortex_platform.is_non_nil_uuid(
          declaration_target ->> 'applicationRootId'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
          where supplied.key <> all (array['kind', 'applicationRootId'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' not in ('permission', 'delegated_management')
    or (
      declaration_authority ->> 'kind' = 'permission'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authority ->> 'kind' = 'delegated_management'
      and (
        not declaration_authority ?& array['before', 'after']
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
          where supplied.key <> all (array['kind', 'before', 'after'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if pg_catalog.jsonb_typeof(scope_candidate) <> 'object'
        or not scope_candidate ? 'kind'
        or pg_catalog.jsonb_typeof(scope_candidate -> 'kind') <> 'string'
        or scope_candidate ->> 'kind' not in (
          'none', 'organization_catalogue', 'bounded'
        )
        or (
          scope_candidate ->> 'kind' in ('none', 'organization_catalogue')
          and exists (
            select 1
            from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
            where supplied.key <> 'kind'
          )
        )
        or (
          scope_candidate ->> 'kind' = 'bounded'
          and (
            not scope_candidate ? 'permissions'
            or pg_catalog.jsonb_typeof(scope_candidate -> 'permissions') <> 'array'
            or pg_catalog.jsonb_array_length(scope_candidate -> 'permissions') = 0
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
              where supplied.key <> all (array['kind', 'permissions'])
            )
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;

    if declaration_authority -> 'before' ->> 'kind' = 'none'
      and declaration_authority -> 'after' ->> 'kind' = 'none' then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end if;

  for permission_candidate in
    select candidate.value
    from (
      select declaration_permission as value
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'before' ->> 'kind' = 'bounded'
          then declaration_authority -> 'before' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'after' ->> 'kind' = 'bounded'
          then declaration_authority -> 'after' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
    ) as candidate
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array['ownerKind', 'ownerId', 'permissionId']
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('platform', 'application', 'module')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'meaningFingerprint'
        ])
      )
      or (permission_candidate ? 'acceptedRegistrationRevision') <>
        (permission_candidate ? 'meaningFingerprint')
      or (permission_candidate ? 'acceptedRegistrationRevision' and (
        pg_catalog.jsonb_typeof(permission_candidate -> 'acceptedRegistrationRevision') <> 'number'
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric
          not between 1 and 9007199254740991
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc((permission_candidate ->> 'acceptedRegistrationRevision')::numeric)
        or pg_catalog.jsonb_typeof(permission_candidate -> 'meaningFingerprint') <> 'string'
        or permission_candidate ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
      ))
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_platform.is_non_nil_uuid(
            permission_candidate ->> 'applicationRootId'
          )
        )
      )
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end loop;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if scope_candidate ->> 'kind' = 'bounded'
        and (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(scope_candidate -> 'permissions')
        ) <> (
          select pg_catalog.count(distinct pg_catalog.concat_ws(
            ':',
            pg_catalog.lower(permission.value ->> 'applicationRootId'),
            permission.value ->> 'ownerKind',
            pg_catalog.lower(permission.value ->> 'ownerId'),
            pg_catalog.lower(permission.value ->> 'permissionId'),
            permission.value ->> 'acceptedRegistrationRevision',
            permission.value ->> 'meaningFingerprint'
          ))
          from pg_catalog.jsonb_array_elements(
            scope_candidate -> 'permissions'
          ) as permission(value)
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;
  end if;

  operation_value := p_declaration ->> 'operationKey';
  target_kind_value := declaration_target ->> 'kind';
  target_application_value := case
    when target_kind_value = 'application'
      then (declaration_target ->> 'applicationRootId')::uuid
    else null
  end;
  permission_application_value := case
    when declaration_permission ? 'applicationRootId'
      then (declaration_permission ->> 'applicationRootId')::uuid
    else null
  end;
  permission_owner_kind_value := declaration_permission ->> 'ownerKind';
  authority_kind_value := declaration_authority ->> 'kind';

  if (target_kind_value = 'organization' and permission_owner_kind_value <> 'platform')
    or (
      target_kind_value = 'application'
      and (
        permission_owner_kind_value = 'platform'
        or permission_application_value is distinct from target_application_value
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := pg_catalog.clock_timestamp();
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := target_kind_value = 'organization'
    or coalesce(context_application_value = target_application_value, false);

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  return query
  with permission_eligibility as materialized (
    select evaluated.path_valid_until
    from vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declaration_permission,
      declaration_action, null::uuid
    ) as evaluated
  ), management_scopes as materialized (
    select declaration_authority -> 'before' as scope
    where authority_kind_value = 'delegated_management'
    union all
    select declaration_authority -> 'after'
    where authority_kind_value = 'delegated_management'
  ), delegation_requirements as materialized (
    -- Existing role revisions name the meaning they accepted. New authority requests use the
    -- current meaning, so an older bounded delegation cannot confer widened permission scope.
    select 'organization_catalogue'::text as requirement_kind,
      null::uuid as application_root_id, null::text as owner_kind,
      null::uuid as owner_id, null::uuid as permission_id,
      null::bigint as accepted_registration_revision,
      null::text as meaning_fingerprint
    where exists (
      select 1 from management_scopes as managed
      where managed.scope ->> 'kind' = 'organization_catalogue'
    )
    union all
    select distinct 'bounded',
      case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid
        else null::uuid
      end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid,
      coalesce(
        (permission.value ->> 'acceptedRegistrationRevision')::bigint,
        current_entry.registration_revision
      ),
      coalesce(permission.value ->> 'meaningFingerprint', current_entry.meaning_fingerprint)
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
    left join lateral (
      select catalogue.registration_revision, catalogue.meaning_fingerprint
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = registration.organization_id
        and catalogue.registration_kind = registration.registration_kind
        and catalogue.registration_owner_id is not distinct from registration.registration_owner_id
        and catalogue.registration_revision = registration.revision
      where registration.organization_id = context_organization_value
        and registration.state = 'active'
        and not permission.value ? 'acceptedRegistrationRevision'
        and catalogue.application_root_id is not distinct from
          (permission.value ->> 'applicationRootId')::uuid
        and catalogue.owner_kind = permission.value ->> 'ownerKind'
        and catalogue.owner_id = (permission.value ->> 'ownerId')::uuid
        and catalogue.permission_id = (permission.value ->> 'permissionId')::uuid
    ) as current_entry on true
  ), current_delegation_paths as materialized (
    select 1 as route_rank, delegation.delegation_authority_id,
      null::uuid as membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value)
      ) as path_valid_until
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = context_account_value
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )

    union all

    select 2, delegation.delegation_authority_id,
      membership.membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from vortex_access.organization_delegation_authorities as delegation
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = delegation.organization_id
      and organization_group.group_id = delegation.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = delegation.organization_id
      and membership.group_id = delegation.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'group'
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )
  ), current_bounded_path_permissions as materialized (
    select path.delegation_authority_id, path.membership_id,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end as application_root_id,
      stored.value ->> 'ownerKind' as owner_kind,
      (stored.value ->> 'ownerId')::uuid as owner_id,
      (stored.value ->> 'permissionId')::uuid as permission_id,
      accepted.registration_revision as accepted_registration_revision,
      accepted.meaning_fingerprint as meaning_fingerprint
    from current_delegation_paths as path
    cross join lateral pg_catalog.jsonb_array_elements(
      path.bounded_permissions
    ) as stored(value)
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      context_organization_value,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid else null::uuid end,
      stored.value ->> 'ownerKind',
      (stored.value ->> 'ownerId')::uuid,
      (stored.value ->> 'permissionId')::uuid,
      (stored.value ->> 'continuityRevision')::numeric::bigint,
      (stored.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      stored.value ->> 'meaningFingerprint'
    ) as accepted
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, requirement.accepted_registration_revision,
      requirement.meaning_fingerprint, path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id,
          requirement.accepted_registration_revision,
          requirement.meaning_fingerprint
        order by path.route_rank, path.delegation_authority_id,
          path.membership_id nulls first
      ) as path_ordinal
    from delegation_requirements as requirement
    join current_delegation_paths as path
      on path.scope_kind = 'organization_catalogue'
      or (
        requirement.requirement_kind = 'bounded'
        and exists (
          select 1
          from current_bounded_path_permissions as covered
          where covered.delegation_authority_id =
              path.delegation_authority_id
            and covered.membership_id is not distinct from path.membership_id
            and covered.application_root_id is not distinct from
              requirement.application_root_id
            and covered.owner_kind = requirement.owner_kind
            and covered.owner_id = requirement.owner_id
            and covered.permission_id = requirement.permission_id
            and requirement.accepted_registration_revision is not null
            and covered.meaning_fingerprint = requirement.meaning_fingerprint
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
      candidate.accepted_registration_revision, candidate.meaning_fingerprint,
      candidate.path_valid_until
    from delegation_path_candidates as candidate
    where candidate.path_ordinal = 1
  ), delegation_summary as (
    select pg_catalog.count(*) as requirement_count,
      pg_catalog.count(selected.requirement_kind) as selected_count,
      pg_catalog.min(selected.path_valid_until) as path_valid_until
    from delegation_requirements as requirement
    left join selected_delegation_paths as selected
      on selected.requirement_kind = requirement.requirement_kind
      and selected.application_root_id is not distinct from
        requirement.application_root_id
      and selected.owner_kind is not distinct from requirement.owner_kind
      and selected.owner_id is not distinct from requirement.owner_id
      and selected.permission_id is not distinct from requirement.permission_id
      and selected.accepted_registration_revision is not distinct from
        requirement.accepted_registration_revision
      and selected.meaning_fingerprint is not distinct from requirement.meaning_fingerprint
  ), decision as (
    select exists(select 1 from permission_eligibility) as permission_available,
      (
        select pg_catalog.min(selected.path_valid_until)
        from permission_eligibility as selected
      ) as path_valid_until,
      authority_kind_value = 'permission'
        or (
          delegation.requirement_count > 0
          and delegation.requirement_count = delegation.selected_count
        ) as delegation_satisfied,
      delegation.path_valid_until as delegation_valid_until
    from (select 1) as singleton
    cross join delegation_summary as delegation
  )
  select
    case
      when not context_current
        or unsupported_context or not target_context_satisfied then 'refused'
      when not decision.permission_available then 'refused'
      when decision.path_valid_until is null then 'refused'
      when not authentication_satisfied then 'refused'
      when not decision.delegation_satisfied then 'refused'
      else 'eligible'
    end,
    operation_value,
    target_kind_value,
    target_application_value,
    context_organization_value,
    context_account_value,
    context_access_version_value,
    decision_checked_at,
    case
      when context_current
        and not unsupported_context
        and target_context_satisfied
        and decision.permission_available
        and decision.path_valid_until is not null
        and authentication_satisfied
        and decision.delegation_satisfied
      then least(
        decision.path_valid_until,
        authentication_deadline,
        coalesce(decision.delegation_valid_until, context_expires_value)
      )
      else null
    end,
    context_correlation_value,
    case
      when not context_current
        or unsupported_context or not target_context_satisfied
        then 'target_policy_unavailable'
      when not decision.permission_available then 'permission_unavailable'
      when decision.path_valid_until is null then 'permission_not_effective'
      when not authentication_satisfied and declaration_authentication ->> 'kind' = 'multi_factor'
        then 'multi_factor_unsatisfied'
      when not authentication_satisfied then 'authentication_unsatisfied'
      when not decision.delegation_satisfied then 'delegation_insufficient'
      else null
    end
  from decision;
end
$function$;
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb) owner to vortex_owner;

revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_owner, postgres;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permissions jsonb;
  declaration_binding jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  permission_candidate jsonb;
  previous_identity text;
  candidate_identity text;
  operation_value text;
  action_kind_value text;
  target_application_value uuid;
  binding_record_type_value uuid;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
  catalogue_available boolean := false;
  scoped_available boolean := false;
  path_effective boolean := false;
  eligible_permissions jsonb;
  eligible_valid_until timestamptz;
  refusal_reason text;
  evidence jsonb;
  requirement jsonb;
  requirement_candidate record;
  requirement_granted record;
  requirement_valid_until timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermissions',
      'recordBinding', 'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermissions',
        'recordBinding', 'recentAuthentication', 'authority', 'contributorRequirements'
      ])
    )
    or (
      p_declaration ? 'contributorRequirements'
      and (
        pg_catalog.jsonb_typeof(p_declaration -> 'contributorRequirements') <> 'array'
        or pg_catalog.jsonb_array_length(p_declaration -> 'contributorRequirements') not between 1 and 10
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_declaration -> 'contributorRequirements') as item(value)
          where pg_catalog.jsonb_typeof(item.value) <> 'object'
            or not item.value ?& array[
              'moduleRootId', 'applicationRootIds', 'recordTypeId', 'permissionKeys', 'changeableFieldIds'
            ]
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(item.value) as supplied(key)
              where supplied.key <> all (array[
                'moduleRootId', 'applicationRootIds', 'recordTypeId', 'permissionKeys', 'changeableFieldIds'
              ])
            )
            or not vortex_platform.is_non_nil_uuid(item.value ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
            or pg_catalog.jsonb_typeof(item.value -> 'applicationRootIds') <> 'array'
            or pg_catalog.jsonb_typeof(item.value -> 'permissionKeys') <> 'array'
            or pg_catalog.jsonb_typeof(item.value -> 'changeableFieldIds') <> 'array'
        )
      )
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permissions := p_declaration -> 'requiredPermissions';
  declaration_binding := p_declaration -> 'recordBinding';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'transfer', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ?& array['kind', 'applicationRootId']
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
      where supplied.key <> all (array['kind', 'applicationRootId'])
    )
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' <> 'application'
    or not vortex_platform.is_non_nil_uuid(
      declaration_target ->> 'applicationRootId'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_binding) <> 'object'
    or not declaration_binding ?& array[
      'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_binding) as supplied(key)
      where supplied.key <> all (array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
      ])
    )
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(
      declaration_binding ->> 'storageContractId'
    )
    or pg_catalog.jsonb_typeof(declaration_binding -> 'storageScope') <> 'string'
    or declaration_binding ->> 'storageScope' not in (
      'organization_shared', 'application_contained'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  -- A record operation carries ordinary permission authority only; delegated
  -- management scopes stay on the existing non-record path.
  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' <> 'permission'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
      where supplied.key <> 'kind'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(declaration_permissions) = 0 then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  previous_identity := null;
  for permission_candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
      ]
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('application', 'module')
      or not vortex_platform.is_non_nil_uuid(
        permission_candidate ->> 'applicationRootId'
      )
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or pg_catalog.lower(permission_candidate ->> 'applicationRootId') <>
        pg_catalog.lower(declaration_target ->> 'applicationRootId')
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      )
      or (
        permission_candidate ->> 'ownerKind' = 'module'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(declaration_binding ->> 'moduleRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;

    candidate_identity := pg_catalog.concat_ws(
      ':',
      pg_catalog.lower(permission_candidate ->> 'applicationRootId'),
      permission_candidate ->> 'ownerKind',
      pg_catalog.lower(permission_candidate ->> 'ownerId'),
      pg_catalog.lower(permission_candidate ->> 'permissionId')
    );
    if previous_identity is not null
      and previous_identity collate "C" >= candidate_identity then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;
    previous_identity := candidate_identity;
  end loop;

  operation_value := p_declaration ->> 'operationKey';
  action_kind_value := declaration_action ->> 'actionKind';
  target_application_value := (declaration_target ->> 'applicationRootId')::uuid;
  binding_record_type_value := (declaration_binding ->> 'recordTypeId')::uuid;

  if action_kind_value = 'named'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
      where item.value ->> 'ownerKind' <>
          declaration_permissions -> 0 ->> 'ownerKind'
        or pg_catalog.lower(item.value ->> 'ownerId') <>
          pg_catalog.lower(declaration_permissions -> 0 ->> 'ownerId')
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  context_value := p_context;
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := p_checked_at;
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := coalesce(
    context_application_value = target_application_value, false
  );

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  -- Every declared alternative is evaluated against its exact record type by the
  -- shared role-path helper under this one context and checked time. A candidate
  -- keeps its own catalogue record scope, immutable source release and path
  -- deadline; an alternative never lends authority to another. Keeping
  -- path_valid_until separate from authentication_deadline here (instead of
  -- combining them per row) is what lets the three existence flags below tell
  -- "no catalogue entry", "entry without record scope" and "scoped entry
  -- without a live path" apart as distinct refusal reasons.
  with candidate as (
    select declared.ordinality as alternative_ordinal,
      -- A preview's system projection uses the builder's live registration. Keep that
      -- registration's permission address with its accepted meaning for every later reader.
      pg_catalog.jsonb_build_object(
        'applicationRootId', (evaluated.permission_entry).application_root_id,
        'ownerKind', (evaluated.permission_entry).owner_kind,
        'ownerId', (evaluated.permission_entry).owner_id,
        'permissionId', (evaluated.permission_entry).permission_id
      ) as permission_value,
      (evaluated.permission_entry).registration_revision as registration_revision,
      (evaluated.permission_entry).record_scope as record_scope,
      pg_catalog.jsonb_build_object(
        'kind', (evaluated.permission_entry).source_kind,
        'definitionKey', (evaluated.permission_entry).source_definition_key,
        'rootId', (evaluated.permission_entry).source_root_id,
        'releaseRevision', (evaluated.permission_entry).source_revision,
        'releaseVersion', (evaluated.permission_entry).source_version,
        'validationContractVersion',
          (evaluated.permission_entry).source_validation_contract_version
      ) as source_release,
      evaluated.path_valid_until as path_valid_until
    from pg_catalog.jsonb_array_elements(declaration_permissions)
      with ordinality as declared(value, ordinality)
    cross join lateral vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declared.value, declaration_action,
      binding_record_type_value
    ) as evaluated
  )
  select pg_catalog.count(*) > 0,
    pg_catalog.count(*) filter (where candidate.record_scope is not null) > 0,
    pg_catalog.count(*) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
    ) > 0,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'permission', candidate.permission_value,
        'registrationRevision', candidate.registration_revision,
        'recordScope', candidate.record_scope,
        'source', candidate.source_release,
        'validUntil', pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', least(candidate.path_valid_until, authentication_deadline)
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by candidate.alternative_ordinal
    ) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
        and authentication_deadline is not null
    ),
    pg_catalog.min(least(candidate.path_valid_until, authentication_deadline))
      filter (
        where candidate.record_scope is not null
          and candidate.path_valid_until is not null
          and authentication_deadline is not null
      )
  into catalogue_available, scoped_available, path_effective, eligible_permissions,
    eligible_valid_until
  from candidate;

  evidence := pg_catalog.jsonb_build_object(
    'operationKey', operation_value,
    'target', declaration_target,
    'organizationId', context_organization_value,
    'organizationAccountId', context_account_value,
    'accessVersion', context_access_version_value,
    'checkedAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', decision_checked_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_value,
    'recordBinding', declaration_binding
  );

  -- Refusal precedence keeps each cause distinguishable: an unsupported
  -- context always wins; then "no candidate has any catalogue entry"; then
  -- "entries exist but none carries record_scope"; then "scoped entries exist
  -- but none has a live role path"; only then does recent-authentication
  -- refuse an otherwise-complete set of alternatives.
  refusal_reason := case
    when not context_current
      or unsupported_context or not target_context_satisfied
      then 'target_policy_unavailable'
    when not catalogue_available then 'permission_unavailable'
    when not scoped_available then 'target_policy_unavailable'
    when not path_effective then 'permission_not_effective'
    when not authentication_satisfied and declaration_authentication ->> 'kind' = 'multi_factor'
        then 'multi_factor_unsatisfied'
      when not authentication_satisfied then 'authentication_unsatisfied'
    else null
  end;

  if refusal_reason is not null then
    return evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', refusal_reason
    );
  end if;

  -- Another installed Module that contributed what this operation acts on adds its own
  -- requirement to the owner's: the person must also hold, through a current role path, a
  -- permission that Module declared for the operation, whose record scope is unconditional and
  -- whose field policy lets the person change every field the operation changes. The owner's
  -- permissions above still decide the record; this only narrows who may use the contribution.
  if p_declaration ? 'contributorRequirements' then
    for requirement in
      select item.value
      from pg_catalog.jsonb_array_elements(p_declaration -> 'contributorRequirements') as item(value)
    loop
      requirement_valid_until := null;
      for requirement_candidate in
        select distinct entry.application_root_id, entry.owner_kind, entry.owner_id,
          entry.permission_id, entry.record_type_id, entry.named_action
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = context_organization_value
          and entry.registration_kind = 'application'
          and entry.owner_kind = 'module'
          and entry.owner_id = (requirement ->> 'moduleRootId')::uuid
          and entry.record_type_id = (requirement ->> 'recordTypeId')::uuid
          and entry.action_kind = 'named'
          and entry.application_root_id in (
            select pg_catalog.lower(application.value)::uuid
            from pg_catalog.jsonb_array_elements_text(requirement -> 'applicationRootIds') as application(value)
          )
          and entry.permission_key in (
            select permission_key.value
            from pg_catalog.jsonb_array_elements_text(requirement -> 'permissionKeys') as permission_key(value)
          )
        order by entry.application_root_id, entry.permission_id
      loop
        for requirement_granted in
          select path.permission_entry, path.path_valid_until
          from vortex_access.evaluate_permission_role_path_internal(
            context_value, decision_checked_at,
            pg_catalog.jsonb_build_object(
              'applicationRootId', requirement_candidate.application_root_id,
              'ownerKind', requirement_candidate.owner_kind,
              'ownerId', requirement_candidate.owner_id,
              'permissionId', requirement_candidate.permission_id
            ),
            pg_catalog.jsonb_build_object(
              'actionKind', 'named', 'namedAction', requirement_candidate.named_action
            ),
            requirement_candidate.record_type_id
          ) as path
        loop
          if requirement_granted.path_valid_until is null
            or requirement_granted.path_valid_until <= decision_checked_at
            or pg_catalog.jsonb_typeof((requirement_granted.permission_entry).record_scope) is distinct from 'object'
            or (requirement_granted.permission_entry).record_scope ? 'savedCondition'
            or not coalesce(
              (requirement_granted.permission_entry).record_scope -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
              false
            )
            or pg_catalog.jsonb_typeof((requirement_granted.permission_entry).field_policy) is distinct from 'object'
            or exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(requirement -> 'changeableFieldIds') as required_field(value)
              where not exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  (requirement_granted.permission_entry).field_policy -> 'changeableFieldIds'
                ) as allowed_field(value)
                where pg_catalog.lower(allowed_field.value) = pg_catalog.lower(required_field.value)
              )
            ) then
            continue;
          end if;
          requirement_valid_until := greatest(
            coalesce(requirement_valid_until, requirement_granted.path_valid_until),
            requirement_granted.path_valid_until
          );
        end loop;
      end loop;
      if requirement_valid_until is null then
        return evidence || pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', 'permission_not_effective'
        );
      end if;
      eligible_valid_until := least(eligible_valid_until, requirement_valid_until);
    end loop;
  end if;

  return evidence || pg_catalog.jsonb_build_object(
    'outcome', 'eligible',
    'validUntil', pg_catalog.to_char(
      pg_catalog.timezone('UTC', eligible_valid_until),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'eligiblePermissions', eligible_permissions
  );
end
$_$;

ALTER FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) IS 'Private record-permission eligibility evidence per declared alternative; carries the declared record binding as context and is never a record allow result. The caller supplies one Access-bound context and checked time.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) TO vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to vortex_record_adapter;

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
  stored record;
  claimed jsonb;
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
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_steward_identity_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_account_id)
      ],
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_organization_id)
      ],
      stored."receiptId",
      stored."acceptedAt";
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
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;

grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'archive_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'rename_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) owner to vortex_owner;

grant execute on function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or (
      p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reparent_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reparent_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) to postgres;

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
  stored record;
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant_tenant_administrator',
      p_tenant_id::text, p_subject_identity_id::text, pg_catalog.array_to_string(capabilities, ','),
      vortex_platform.format_timestamp_utc(p_starts_at),
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), '')),
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'grant_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[new_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[1::bigint]),
      'fingerprint', computed_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

alter function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
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
      vortex_platform.format_timestamp_utc(p_starts_at),
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'change_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', computed_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

alter function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
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
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      p_assignment_id, stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

alter function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;


-- Keep table reads behind the scoped security-definer functions.
CREATE OR REPLACE FUNCTION vortex_platform.decide_file_read(p_file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  stored_organization_id uuid;
  stored_application_root_id uuid;
  stored_record_type_id uuid;
  stored_record_id uuid;
  stored_field_id uuid;
  stored_lifecycle_state text;
  stored_scanner_result text;
  projection jsonb;
  attached jsonb;
begin
  if p_file_id is null
    or p_file_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  select stored.organization_id, stored.application_root_id,
    stored.owner_record_type_id, stored.owner_record_id, stored.owner_field_id,
    stored.lifecycle_state, stored.scanner_result
  into stored_organization_id, stored_application_root_id,
    stored_record_type_id, stored_record_id, stored_field_id,
    stored_lifecycle_state, stored_scanner_result
  from vortex_platform.file_records as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (select vortex_platform.organization_id());
  if not found
    or stored_record_id is null
    or stored_lifecycle_state <> 'active'
    or stored_scanner_result <> 'clean' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  projection := (vortex_record.read_record(stored_record_type_id, stored_record_id)) -> 'record';
  if projection ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  attached := projection -> 'values' -> (stored_field_id::text);
  if pg_catalog.jsonb_typeof(attached) is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(attached) as member(value)
      where pg_catalog.jsonb_typeof(member.value) = 'string'
        and pg_catalog.lower(member.value #>> '{}') = p_file_id::text
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'organizationId', stored_organization_id,
    'applicationRootId', stored_application_root_id,
    'recordTypeId', stored_record_type_id,
    'recordId', stored_record_id,
    'fieldId', stored_field_id
  ));
end
$$;

alter function vortex_platform.decide_file_read(p_file_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) IS 'Decides current read authority for a file through the protected record read and the attachment value that names it.';

REVOKE ALL ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) TO vortex_request;

grant execute on function vortex_platform.decide_file_read(p_file_id uuid) to postgres;

revoke select on vortex_platform.file_records from vortex_request;
drop policy file_records_request_read on vortex_platform.file_records;
revoke select on vortex_record.documents from vortex_request;
drop policy documents_request_read on vortex_record.documents;

reset role;
