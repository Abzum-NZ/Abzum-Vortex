set local role vortex_owner;

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
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
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  person_record_type_id uuid;
  installation_plan jsonb;
  installation_record_types jsonb;
  after_occurred_at timestamptz;
  after_record_id uuid;
  keyset_sql text := '';
  base_sql text;
  source_sql text;
  order_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  -- The action is the one filterable key (the record title); there is no searchable key.
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "action": {"sql": "entry.action", "database": "text", "filter": true}
    }$declared$::jsonb,
    10
  );
  if p_sort_key <> 'occurred_at' or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Activity projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) <> 'string'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end if;
    begin
      after_occurred_at := (p_after -> 'sortKey' ->> 0)::timestamptz;
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end;
    keyset_sql := case when p_direction = 'descending'
      then ' and (entry.occurred_at, entry.activity_id) < ($6, $7)'
      else ' and (entry.occurred_at, entry.activity_id) > ($6, $7)' end;
  end if;
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.activity.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  -- Use this request's validated live/preview installation, including its pins.
  installation_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  select pg_catalog.jsonb_agg(installed.value) into installation_record_types
  from pg_catalog.jsonb_each(installation_plan -> 'recordTypes') as installed(key, value);
  person_record_type_id := vortex_access.resolve_installed_account_record_type_internal(
    installation_record_types
  );

  order_sql := pg_catalog.format(
    ' order by entry.occurred_at %s, entry.activity_id %s limit $8',
    case when p_direction = 'descending' then 'desc' else 'asc' end,
    case when p_direction = 'descending' then 'desc' else 'asc' end
  );
  base_sql := $scan$select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = $1
      and entry.occurred_at >= pg_catalog.statement_timestamp() - interval '90 days'
      and ($2 is null or entry.activity_id = any($2))$scan$
    || coalesce(' and ' || (predicate_plan ->> 'predicate'), '');
  if audit_projection then
    source_sql := base_sql || keyset_sql || order_sql;
  else
    source_sql := 'select visible.* from (('
      || base_sql
      || ' and entry.actor_kind = ''organization_account'' and entry.actor_id = $4'
      || keyset_sql || order_sql
      || ') union all ('
      || base_sql
      || ' and entry.actor_kind = ''identity'' and entry.actor_id = $5'
      || keyset_sql || order_sql
      || ')) as visible'
      || pg_catalog.format(' order by visible.occurred_at %s, visible.activity_id %s limit $8',
        case when p_direction = 'descending' then 'desc' else 'asc' end,
        case when p_direction = 'descending' then 'desc' else 'asc' end);
  end if;
  scan_sql := $scan$select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('recordTypeId', $9, 'recordId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when $3
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from ($scan$ || source_sql || $scan$) as entry$scan$
    || pg_catalog.format(' order by entry.occurred_at %s, entry.activity_id %s',
      case when p_direction = 'descending' then 'desc' else 'asc' end,
      case when p_direction = 'descending' then 'desc' else 'asc' end);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    audit_projection, actor_account_id, actor_identity_id,
    after_occurred_at, after_record_id, p_limit, person_record_type_id,
    predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer, jsonb
) owner to vortex_owner;

drop function vortex_record.read_organization_activity_aggregates(timestamptz, timestamptz, text, uuid, text, uuid, text, text, text);
drop function vortex_record.read_organization_activity_page(timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid);


-- Do not silently remove a restriction or a persisted execution binding.
do $preflight$
declare
  affected record;
begin
  select organization_id, role_id into affected
  from vortex_access.organization_role_activation_policy_revisions
  where required_caller_execution_binding_id is not null
  order by organization_id, role_id limit 1;
  if found then
    raise exception 'Required-caller policy exists for organisation % and role %',
      affected.organization_id, affected.role_id;
  end if;
  select organization_id, execution_binding_id into affected
  from vortex_access.flow_execution_bindings
  order by organization_id, execution_binding_id limit 1;
  if found then
    raise exception 'Flow execution binding % exists for organisation %; no role is associated with the binding',
      affected.execution_binding_id, affected.organization_id;
  end if;
end
$preflight$;

-- No writer remains for flow execution bindings. Existing policy revisions no longer require one.
drop function vortex_access.coordinate_organization_role_activation_change(text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid, bigint, uuid, bigint, uuid, uuid, uuid);
alter table vortex_access.organization_role_activation_policy_revisions drop column required_caller_execution_binding_id;
drop table vortex_access.flow_execution_bindings;

create or replace function vortex_access.coordinate_organization_role_activation_change(
  p_operation text,
  p_organization_id uuid,
  p_role_activation_id uuid,
  p_expected_activation_revision bigint,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_requested_duration_seconds bigint,
  p_eligibility_source_kind text,
  p_role_assignment_id uuid,
  p_expected_role_assignment_revision bigint,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  activation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  activation_fact vortex_access.organization_role_activations%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  duration_cap_seconds numeric;
  source_seconds numeric;
  activation_expires_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in ('activate_role', 'revoke_role_activation')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-activation change input is invalid';
  end if;

  if p_operation = 'activate_role' then
    if p_expected_activation_revision is not null
      or p_organization_account_id is null
      or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_requested_duration_seconds is null
      or p_requested_duration_seconds not between 1 and 9007199254740991
      or p_eligibility_source_kind is null
      or p_eligibility_source_kind not in ('direct', 'group')
      or p_role_assignment_id is null
      or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_assignment_revision is null
      or p_expected_role_assignment_revision not between 1 and 9007199254740991
      or (
        p_eligibility_source_kind = 'direct'
        and (
          p_membership_id is not null
          or p_expected_membership_revision is not null
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          p_membership_id is null
          or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_expected_membership_revision is null
          or p_expected_membership_revision not between 1 and 9007199254740991
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role activation input is invalid';
    end if;
  elsif p_expected_activation_revision is null
    or p_expected_activation_revision not between 1 and 9007199254740991
    or p_organization_account_id is not null
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_requested_duration_seconds is not null
    or p_eligibility_source_kind is not null
    or p_role_assignment_id is not null
    or p_expected_role_assignment_revision is not null
    or p_membership_id is not null
    or p_expected_membership_revision is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-activation revocation input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-activation change scope is unavailable';
  end if;

  if p_operation = 'activate_role' then
    if exists (
      select 1
      from vortex_access.organization_role_activations as stored_activation
      where stored_activation.organization_id = p_organization_id
        and stored_activation.role_activation_id = p_role_activation_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation is stale or unavailable';
    end if;

    select role.live_revision, revision.lifecycle, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      policy.maximum_activation_duration_seconds
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle not in ('active', 'acceptance_required')
      or role_fact.assignment_policy <> 'activation_required'
      or not exists (
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
        where permission.organization_id = p_organization_id
          and permission.role_id = p_role_id
          and permission.role_revision = p_expected_role_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation role evidence is stale or unavailable';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role activation account is stale or unavailable';
    end if;

    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;
    if not found
      or assignment_fact.role_id <> p_role_id
      or assignment_fact.assignment_kind <> 'eligible'
      or assignment_fact.revision <> p_expected_role_assignment_revision
      or assignment_fact.state <> 'live'
      or (
        p_eligibility_source_kind = 'direct'
        and (
          assignment_fact.assignee_kind <> 'organization_account'
          or assignment_fact.organization_account_id <> p_organization_account_id
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and assignment_fact.assignee_kind <> 'group'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation eligibility is stale or unavailable';
    end if;

    if p_eligibility_source_kind = 'group' then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = assignment_fact.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization role activation Group is stale or unavailable';
      end if;

      select membership.* into membership_fact
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = p_organization_id
        and membership.membership_id = p_membership_id
      for update;
      if not found
        or membership_fact.group_id <> assignment_fact.group_id
        or membership_fact.organization_account_id <> p_organization_account_id
        or membership_fact.revision <> p_expected_membership_revision
        or membership_fact.state <> 'live' then
        raise exception using errcode = '40001',
          message = 'Organization role activation membership is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if assignment_fact.starts_at > checked_at
      or (
        assignment_fact.expires_at is not null
        and assignment_fact.expires_at <= checked_at
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          membership_fact.starts_at > checked_at
          or (
            membership_fact.expires_at is not null
            and membership_fact.expires_at <= checked_at
          )
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    duration_cap_seconds := least(
      p_requested_duration_seconds::numeric,
      role_fact.maximum_activation_duration_seconds::numeric
    );
    if assignment_fact.expires_at is not null then
      source_seconds := extract(
        epoch from assignment_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      source_seconds := extract(
        epoch from membership_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if duration_cap_seconds <= 0 then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    begin
      activation_expires_at := checked_at +
        (duration_cap_seconds::double precision * interval '1 second');
    exception
      when datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023',
          message = 'Organization role activation duration is not representable';
    end;
    if assignment_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        assignment_fact.expires_at
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        membership_fact.expires_at
      );
    end if;
    if activation_expires_at in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    ) or activation_expires_at <= checked_at then
      raise exception using errcode = '22023',
        message = 'Organization role activation duration is not representable';
    end if;

    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_activation_id, p_organization_account_id,
      p_role_id, 1, p_expected_role_revision,
      role_fact.authority_continuity_revision,
      role_fact.policy_continuity_revision, role_fact.activation_policy_id,
      role_fact.activation_policy_revision, p_eligibility_source_kind,
      p_role_assignment_id, p_expected_role_assignment_revision,
      p_membership_id, p_expected_membership_revision, 'live', p_changed_by,
      checked_at, activation_expires_at, p_correlation_id, p_changed_by,
      checked_at, p_correlation_id, null, null, null
    ) returning * into activation_fact;
  else
    select stored_activation.* into activation_fact
    from vortex_access.organization_role_activations as stored_activation
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
    for update;

    if not found
      or activation_fact.revision <> p_expected_activation_revision
      or activation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
    if activation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role activation revision is exhausted';
    end if;

    operation_at := greatest(
      activation_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_activations as stored_activation
    set revision = activation_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
      and stored_activation.revision = p_expected_activation_revision
      and stored_activation.state = 'live'
    returning stored_activation.* into activation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_activation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'roleActivationId', activation_fact.role_activation_id,
      'organizationId', activation_fact.organization_id,
      'organizationAccountId', activation_fact.organization_account_id,
      'roleId', activation_fact.role_id,
      'revision', activation_fact.revision,
      'historicalRoleRevision', activation_fact.historical_role_revision,
      'authorityContinuityRevision',
        activation_fact.authority_continuity_revision,
      'policyContinuityRevision', activation_fact.policy_continuity_revision,
      'activationPolicy', pg_catalog.jsonb_build_object(
        'activationPolicyId', activation_fact.activation_policy_id,
        'revision', activation_fact.activation_policy_revision
      ),
      'eligibilitySource', case activation_fact.eligibility_source_kind
        when 'direct' then pg_catalog.jsonb_build_object(
          'kind', 'direct',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          )
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          ),
          'originatingMembership', pg_catalog.jsonb_build_object(
            'membershipId', activation_fact.membership_id,
            'revision', activation_fact.membership_revision
          )
        )
      end,
      'state', activation_fact.state,
      'activatedByActorId', activation_fact.activated_by,
      'activatedAt', activation_fact.activated_at,
      'expiresAt', activation_fact.expires_at,
      'activationCorrelationId', activation_fact.activation_correlation_id,
      'changedByActorId', activation_fact.changed_by,
      'changedAt', activation_fact.changed_at,
      'changeCorrelationId', activation_fact.change_correlation_id,
      'revokedByActorId', activation_fact.revoked_by,
      'revokedAt', activation_fact.revoked_at,
      'revocationCorrelationId', activation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_activation_change(
    text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
    bigint, uuid, bigint, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid
) is
  'Owner-only atomic individual role activation or terminal revocation. It changes Access once but grants no caller authority.';

alter function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid) to postgres;


create or replace function vortex_access.coordinate_role_change_without_stewardship_internal(
  p_evidence jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
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
security invoker
set search_path = ''
as $function$
declare
  candidate jsonb;
  operation_name text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_role_key text;
  target_label text;
  target_description text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_source_role_id uuid;
  target_source_definition_key text;
  target_source_release_revision bigint;
  target_source_release_version text;
  target_source_validation_contract_version text;
  target_accepted_registration_revision bigint;
  target_template_continuity_revision bigint;
  target_role_revision bigint;
  candidate_permissions jsonb;
  canonical_permissions jsonb;
  current_permissions jsonb;
  permission_count bigint;
  template_source jsonb;
  live_permissions jsonb;
  selected_template_count bigint;
  policy_choice jsonb;
  policy_value jsonb;
  policy_reference jsonb;
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  maximum_policy_revision bigint;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
  policy_result jsonb;
begin
  if p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array[
      'contractVersion', 'candidate', 'affectedAssignmentManifest'
    ]::text[] <> '{}'::jsonb
    or not (p_evidence ?& array['contractVersion', 'candidate'])
    or p_evidence ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_evidence -> 'candidate') is distinct from 'object'
    or (p_evidence ? 'affectedAssignmentManifest' and
      pg_catalog.jsonb_typeof(p_evidence -> 'affectedAssignmentManifest')
        is distinct from 'object')
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
  end if;

  candidate := p_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision',
    'retire_role'
  ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change operation is invalid';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'operation') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string' then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;
  if target_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate ->> 'organizationId' <> target_organization_id::text
    or candidate ->> 'roleId' <> target_role_id::text then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if candidate ? 'expectedRoleRevision' then
      raise exception using errcode = '22023',
        message = 'A role creation cannot carry an expected revision';
    end if;
  elsif pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
      is distinct from 'number'
    or (candidate ->> 'expectedRoleRevision')::numeric < 1
    or (candidate ->> 'expectedRoleRevision')::numeric > 9007199254740991
    or (candidate ->> 'expectedRoleRevision')::numeric <>
      pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Expected role revision is invalid';
  else
    expected_role_revision := (candidate ->> 'expectedRoleRevision')::numeric::bigint;
  end if;

  if operation_name = 'retire_role' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
    ]::text[] <> '{}'::jsonb
      or not (candidate ?& array[
        'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
      ]) then
      raise exception using errcode = '22023',
        message = 'Role retirement shape is invalid';
    end if;
  else
    if not (candidate ?& array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'assignmentPolicy')
        is distinct from 'object'
      or pg_catalog.char_length(candidate ->> 'key') not between 1 and 40
      or candidate ->> 'key' !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or candidate ->> 'label' <> pg_catalog.btrim(candidate ->> 'label')
      or pg_catalog.char_length(candidate ->> 'label') not between 1 and 60
      or candidate ->> 'description' <> pg_catalog.btrim(candidate ->> 'description')
      or pg_catalog.char_length(candidate ->> 'description') not between 1 and 1000
      or candidate ->> 'privilegeClassification' not in ('standard', 'privileged') then
      raise exception using errcode = '22023',
        message = 'Role configuration shape is invalid';
    end if;
    target_role_key := candidate ->> 'key';
    target_label := candidate ->> 'label';
    target_description := candidate ->> 'description';
    target_privilege_classification := candidate ->> 'privilegeClassification';
  end if;

  if operation_name in (
    'create_custom', 'revise_custom_permissions', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  ) then
    if pg_catalog.jsonb_typeof(candidate -> 'permissions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'permissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Role permission evidence is invalid';
    end if;
    candidate_permissions := candidate -> 'permissions';
  elsif candidate ? 'permissions' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry permissions';
  end if;

  if operation_name in (
    'create_custom_from_template', 'accept_new_application_role',
    'accept_application_role_revision'
  ) then
    if not (candidate ?& array[
      'templateSource', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'templateSource') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate -> 'sourceRoleId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'templateContinuityRevision')
        is distinct from 'number'
      or (candidate ->> 'templateContinuityRevision')::numeric < 1
      or (candidate ->> 'templateContinuityRevision')::numeric > 9007199254740991
      or (candidate ->> 'templateContinuityRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'templateContinuityRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;
    template_source := candidate -> 'templateSource';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'templateSource'
    or candidate ? 'sourceRoleId'
    or candidate ? 'templateContinuityRevision' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry template evidence';
  end if;

  if operation_name = 'create_custom' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'templateSource',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'templateSource', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
    end if;
  end if;

  if operation_name <> 'retire_role' then
    policy_choice := candidate -> 'assignmentPolicy';
    if policy_choice ->> 'kind' = 'standing' then
      if policy_choice <> pg_catalog.jsonb_build_object('kind', 'standing') then
        raise exception using errcode = '22023', message = 'Standing policy shape is invalid';
      end if;
      target_assignment_policy := 'standing';
    elsif policy_choice ->> 'kind' = 'activation_required'
      and policy_choice - array['kind', 'activationPolicy']::text[] = '{}'::jsonb
      and policy_choice ?& array['kind', 'activationPolicy']
      and pg_catalog.jsonb_typeof(policy_choice -> 'activationPolicy') = 'object' then
      target_assignment_policy := 'activation_required';
      if policy_choice #>> '{activationPolicy,selection}' = 'existing' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'reference']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'reference'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,reference}') <>
            'object' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy shape is invalid';
        end if;
        policy_reference := policy_choice #> '{activationPolicy,reference}';
        if policy_reference - array[
          'activationPolicyId', 'revision'
        ]::text[] <> '{}'::jsonb
          or not (policy_reference ?& array[
            'activationPolicyId', 'revision'
          ])
          or pg_catalog.jsonb_typeof(policy_reference -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_reference -> 'revision') <> 'number'
          or (policy_reference ->> 'revision')::numeric < 1
          or (policy_reference ->> 'revision')::numeric > 9007199254740991
          or (policy_reference ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_reference ->> 'revision')::numeric) then
          raise exception using errcode = '22023',
            message = 'Existing activation policy evidence is invalid';
        end if;
        target_activation_policy_id := (policy_reference ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_reference ->> 'revision')::numeric::bigint;
      elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'policy']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'policy'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,policy}') <> 'object' then
          raise exception using errcode = '22023',
            message = 'New activation policy shape is invalid';
        end if;
        policy_value := policy_choice #> '{activationPolicy,policy}';
        if policy_value - array[
          'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
          'reasonRequired', 'recentAuthentication'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or (policy_value ->> 'revision')::numeric < 1
          or (policy_value ->> 'revision')::numeric > 9007199254740991
          or (policy_value ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_value ->> 'revision')::numeric)
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric < 1
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric >
            9007199254740991
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric <>
            pg_catalog.trunc(
              (policy_value ->> 'maximumActivationDurationSeconds')::numeric
            ) then
          raise exception using errcode = '22023',
            message = 'New activation policy evidence is invalid';
        end if;
        if policy_value #>> '{recentAuthentication,kind}' = 'none' then
          if policy_value -> 'recentAuthentication' <>
            pg_catalog.jsonb_build_object('kind', 'none') then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        elsif policy_value #>> '{recentAuthentication,kind}' in ('primary', 'multi_factor') then
          if (policy_value -> 'recentAuthentication') - array[
            'kind', 'maximumAgeSeconds'
          ]::text[] <> '{}'::jsonb
            or not ((policy_value -> 'recentAuthentication') ?& array[
              'kind', 'maximumAgeSeconds'
            ])
            or pg_catalog.jsonb_typeof(
              policy_value #> '{recentAuthentication,maximumAgeSeconds}'
            ) <> 'number'
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric < 1
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric >
              9007199254740991
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric <>
              pg_catalog.trunc(
                (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric
              ) then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        else
          raise exception using errcode = '22023',
            message = 'Recent authentication policy is invalid';
        end if;
        target_activation_policy_id := (policy_value ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_value ->> 'revision')::numeric::bigint;
      else
        raise exception using errcode = '22023',
          message = 'Activation-required policy selection is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Assignment policy is invalid';
    end if;
  end if;

  if candidate_permissions is not null then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'kind', 'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ])
        or item.value ->> 'kind' is distinct from 'exact'
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'continuityRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'catalogueFingerprint')
          is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'meaningFingerprint')
          is distinct from 'string'
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or item.value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or (item.value ->> 'acceptedRegistrationRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc(
            (item.value ->> 'acceptedRegistrationRevision')::numeric
          )
        or (item.value ->> 'continuityRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'continuityRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'continuityRevision')::numeric)
        or (
          item.value ->> 'ownerKind' = 'platform'
          and item.value ? 'applicationRootId'
        )
        or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId')
            is distinct from 'string'
        )
    ) then
      raise exception using errcode = '22023', message = 'Role permission entry is invalid';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'exact',
        'applicationRootId', case
          when item.value ? 'applicationRootId'
            then (item.value ->> 'applicationRootId')::uuid
          else null
        end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid,
        'acceptedRegistrationRevision',
          (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
        'catalogueFingerprint', item.value ->> 'catalogueFingerprint',
        'continuityRevision',
          (item.value ->> 'continuityRevision')::numeric::bigint,
        'meaningFingerprint', item.value ->> 'meaningFingerprint'
      )) order by
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end nulls last,
        (item.value ->> 'ownerKind') collate "C",
        (item.value ->> 'ownerId')::uuid,
        (item.value ->> 'permissionId')::uuid
    ) into canonical_permissions
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);

    if canonical_permissions is distinct from candidate_permissions then
      raise exception using errcode = '22023',
        message = 'Role permissions must use canonical unique identity order';
    end if;
    select pg_catalog.count(*), pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      case when item.value ? 'applicationRootId'
        then (item.value ->> 'applicationRootId')::uuid else null end,
      item.value ->> 'ownerKind',
      (item.value ->> 'ownerId')::uuid,
      (item.value ->> 'permissionId')::uuid
    ))
    into permission_count, selected_template_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);
    if permission_count <> selected_template_count then
      raise exception using errcode = '22023',
        message = 'Role permission identities must be unique';
    end if;
  end if;

  if template_source is not null then
    if template_source - array[
      'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (template_source ?& array[
        'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
      ])
      or pg_catalog.jsonb_typeof(template_source -> 'applicationRootId') <> 'string'
      or vortex_platform.is_non_nil_uuid(template_source ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(template_source -> 'registrationRevision') <> 'number'
      or (template_source ->> 'registrationRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'registrationRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'registrationRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'catalogueFingerprint') <> 'string'
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (template_source ->> 'registrationRevision')::numeric::bigint;
    target_application_root_id := (template_source ->> 'applicationRootId')::uuid;

    -- The evidence names the registration; the source release and the role's live permissions
    -- are read from it here, exactly as the preparation read them.
    select registration.source_definition_key, registration.source_revision,
      registration.source_version, registration.validation_contract_version
    into target_source_definition_key, target_source_release_revision,
      target_source_release_version, target_source_validation_contract_version
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
      and registration.permission_catalogue_fingerprint =
        template_source ->> 'catalogueFingerprint';
    if not found then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      target_organization_id, target_application_root_id,
      target_accepted_registration_revision, target_source_role_id
    );
    if live_permissions is null or pg_catalog.jsonb_array_length(live_permissions) = 0 then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;
  end if;

  manifest := p_evidence -> 'affectedAssignmentManifest';

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-change scope is unavailable';
  end if;

  if candidate_permissions is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on registration.organization_id = target_organization_id
      and registration.registration_kind = case
        when item.value ->> 'ownerKind' = 'platform' then 'platform'
        else 'application'
      end
      and registration.registration_owner_id = case
        when item.value ->> 'ownerKind' = 'platform'
          then vortex_access.platform_permission_owner_id()
        else (item.value ->> 'applicationRootId')::uuid
      end
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
      and registration.state = 'active'
    order by registration.registration_kind collate "C",
      registration.registration_owner_id
    for update of registration;

    perform 1
    from vortex_access.permission_continuities as continuity
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id
    for update of continuity;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (item.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint = item.value ->> 'meaningFingerprint'
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_kind = continuity.registration_kind
      and registration.registration_owner_id = continuity.registration_owner_id
      and registration.state = 'active'
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = continuity.organization_id
      and catalogue.registration_kind = continuity.registration_kind
      and catalogue.registration_owner_id = continuity.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.owner_kind = continuity.owner_kind
      and catalogue.owner_id = continuity.owner_id
      and catalogue.permission_id = continuity.permission_id
      and catalogue.application_root_id is not distinct from continuity.application_root_id
      and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions) then
      raise exception using errcode = '40001',
        message = 'Role permission evidence is stale or unavailable';
    end if;
  end if;

  if template_source is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
    ;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application registration is stale or unavailable';
    end if;

    perform 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = target_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.continuity_revision = target_template_continuity_revision
      and continuity.last_processed_registration_revision =
        target_accepted_registration_revision
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as permission(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(live_permissions) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value ->> 'permissionId')::uuid =
          (permission.value ->> 'permissionId')::uuid
        and live.value ->> 'meaningFingerprint' =
          permission.value ->> 'meaningFingerprint'
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(live_permissions)
      ) then
      raise exception using errcode = '40001',
        message = 'Role permissions do not match the current application template';
    end if;
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if found then
      raise exception using errcode = '40001',
        message = 'Organization role identity already exists';
    end if;

    target_role_revision := 1;
    target_policy_continuity_revision := 1;
    target_authority_continuity_revision := 1;
    target_role_kind := case
      when operation_name = 'accept_new_application_role' then 'application'
      else 'custom'
    end;
    target_lifecycle := 'active';
    operation_at := pg_catalog.clock_timestamp();

    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, derived_application_root_id, derived_source_role_id,
      derived_source_definition_key, derived_source_release_revision,
      derived_source_release_version, derived_source_validation_contract_version,
      live_revision, created_by, created_at
    ) values (
      target_organization_id, target_role_id, target_role_kind, target_role_key,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      case when target_role_kind = 'application' then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_application_root_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_definition_key else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_revision else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_validation_contract_version else null end,
      1, p_changed_by, operation_at
    );

    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;

    if operation_name = 'create_custom_from_template' then
      target_application_root_id := null;
      target_source_role_id := null;
      target_source_definition_key := null;
      target_source_release_revision := null;
      target_source_release_version := null;
      target_source_validation_contract_version := null;
      target_accepted_registration_revision := null;
      target_template_continuity_revision := null;
    end if;
  else
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if not found or role_identity.live_revision <> expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale or unavailable';
    end if;
    if role_identity.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '23514',
        message = 'Current organization role revision is unavailable';
    end if;
    if current_revision.lifecycle = 'retired' then
      raise exception using errcode = '40001',
        message = 'A retired organization role is terminal';
    end if;
    if operation_name = 'revise_custom_permissions'
      and role_identity.role_kind <> 'custom' then
      raise exception using errcode = '40001',
        message = 'Custom role permission revision requires a custom role';
    end if;
    if operation_name = 'accept_application_role_revision'
      and (
        role_identity.role_kind <> 'application'
        or role_identity.application_root_id <> target_application_root_id
        or role_identity.source_role_id <> target_source_role_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application role acceptance targets the wrong role source';
    end if;
    target_role_revision := role_identity.live_revision + 1;
  end if;

  if operation_at is null then
    operation_at := pg_catalog.clock_timestamp();
  end if;
  if operation_name not in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    target_role_kind := role_identity.role_kind;
    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    target_lifecycle := case
      when operation_name = 'retire_role' then 'retired'
      else current_revision.lifecycle
    end;
    target_privilege_classification := case
      when operation_name = 'retire_role' then current_revision.privilege_classification
      else target_privilege_classification
    end;
    target_assignment_policy := case
      when operation_name = 'retire_role' then current_revision.assignment_policy
      else target_assignment_policy
    end;
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
      target_activation_policy_id := current_revision.activation_policy_id;
      target_activation_policy_revision := current_revision.activation_policy_revision;
    end if;
    target_source_definition_key := current_revision.source_definition_key;
    target_source_release_revision := current_revision.source_release_revision;
    target_source_release_version := current_revision.source_release_version;
    target_source_validation_contract_version :=
      current_revision.source_validation_contract_version;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_accepted_registration_revision := null;
    target_template_continuity_revision := null;
  elsif operation_name = 'accept_application_role_revision' then
    target_lifecycle := 'active';
  end if;

  if operation_name <> 'retire_role' then
    if target_assignment_policy = 'standing' then
      target_activation_policy_id := null;
      target_activation_policy_revision := null;
    elsif policy_value is null then
      perform 1
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id
        and policy.revision = target_activation_policy_revision;
      if not found then
        raise exception using errcode = '40001',
          message = 'Existing role activation policy is stale or unavailable';
      end if;
    else
      select pg_catalog.max(policy.revision) into maximum_policy_revision
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id;
      if maximum_policy_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'New role activation policy revision is exhausted';
      end if;
      if (maximum_policy_revision is null and target_activation_policy_revision <> 1)
        or (maximum_policy_revision is not null
          and target_activation_policy_revision <> maximum_policy_revision + 1) then
        raise exception using errcode = '40001',
          message = 'New role activation policy revision is stale or invalid';
      end if;
    end if;
  end if;

  if current_revision.organization_id is not null then
    if current_revision.assignment_policy = target_assignment_policy
      and current_revision.activation_policy_id is not distinct from
        target_activation_policy_id
      and current_revision.activation_policy_revision is not distinct from
        target_activation_policy_revision then
      target_policy_continuity_revision := current_revision.policy_continuity_revision;
    else
      if current_revision.policy_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role policy continuity is exhausted';
      end if;
      target_policy_continuity_revision :=
        current_revision.policy_continuity_revision + 1;
    end if;
  end if;

  if current_revision.organization_id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      ),
      '[]'::jsonb
    ) into current_permissions
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    candidate_permissions := current_permissions;
  end if;
  permissions_changed := current_revision.organization_id is not null
    and candidate_permissions is distinct from current_permissions;

  if operation_name = 'revise_custom_permissions' and not permissions_changed then
    raise exception using errcode = '40001',
      message = 'Explicit custom permission revision must change the accepted set';
  end if;
  if operation_name = 'accept_application_role_revision'
    and current_revision.lifecycle = 'active'
    and not permissions_changed
    and current_revision.source_definition_key is not distinct from
      target_source_definition_key
    and current_revision.source_release_revision is not distinct from
      target_source_release_revision
    and current_revision.source_release_version is not distinct from
      target_source_release_version
    and current_revision.source_validation_contract_version is not distinct from
      target_source_validation_contract_version
    and current_revision.accepted_registration_revision is not distinct from
      target_accepted_registration_revision
    and current_revision.template_continuity_revision is not distinct from
      target_template_continuity_revision then
    raise exception using errcode = '40001',
      message = 'Explicit application acceptance must change accepted source evidence';
  end if;

  if current_revision.organization_id is not null then
    configured_state_changed :=
      current_revision.role_key is distinct from target_role_key
      or current_revision.label is distinct from target_label
      or current_revision.description is distinct from target_description
      or current_revision.privilege_classification is distinct from
        target_privilege_classification
      or current_revision.assignment_policy is distinct from target_assignment_policy
      or current_revision.activation_policy_id is distinct from target_activation_policy_id
      or current_revision.activation_policy_revision is distinct from
        target_activation_policy_revision
      or current_revision.lifecycle is distinct from target_lifecycle
      or permissions_changed
      or current_revision.source_definition_key is distinct from target_source_definition_key
      or current_revision.source_release_revision is distinct from
        target_source_release_revision
      or current_revision.source_release_version is distinct from target_source_release_version
      or current_revision.source_validation_contract_version is distinct from
        target_source_validation_contract_version
      or current_revision.accepted_registration_revision is distinct from
        target_accepted_registration_revision
      or current_revision.template_continuity_revision is distinct from
        target_template_continuity_revision;
    if not configured_state_changed then
      raise exception using errcode = '40001',
        message = 'Organization role candidate does not change configured state';
    end if;
  end if;

  if current_revision.organization_id is not null then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as proposed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(current_permissions) as existing(value)
        where existing.value -> 'applicationRootId' is not distinct from
            proposed.value -> 'applicationRootId'
          and existing.value ->> 'ownerKind' = proposed.value ->> 'ownerKind'
          and existing.value ->> 'ownerId' = proposed.value ->> 'ownerId'
          and existing.value ->> 'permissionId' = proposed.value ->> 'permissionId'
          and existing.value ->> 'continuityRevision' =
            proposed.value ->> 'continuityRevision'
          and existing.value ->> 'meaningFingerprint' =
            proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    manifest_required :=
      current_revision.assignment_policy <> target_assignment_policy
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if authority_broadened
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if current_revision.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision + 1;
    else
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision;
    end if;
  end if;

  if manifest_required then
    if manifest is null
      or manifest - array[
        'organizationId', 'roleId', 'assignments'
      ]::text[] <> '{}'::jsonb
      or not (manifest ?& array['organizationId', 'roleId', 'assignments'])
      or pg_catalog.jsonb_typeof(manifest -> 'organizationId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'assignments') <> 'array'
      or (manifest ->> 'organizationId')::uuid <> target_organization_id
      or (manifest ->> 'roleId')::uuid <> target_role_id then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest shape is invalid';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(manifest -> 'assignments') as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or item.value - array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'expectedRevision') <> 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'assignee') <> 'object'
        or (item.value ->> 'expectedRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'expectedRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'expectedRevision')::numeric)
        or not (
          (
            item.value #>> '{assignee,kind}' = 'organization_account'
            and (item.value -> 'assignee') - array[
              'kind', 'organizationAccountId'
            ]::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array[
              'kind', 'organizationAccountId'
            ]
            and pg_catalog.jsonb_typeof(
              item.value #> '{assignee,organizationAccountId}'
            ) = 'string'
          )
          or (
            item.value #>> '{assignee,kind}' = 'group'
            and (item.value -> 'assignee') - array['kind', 'groupId']::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array['kind', 'groupId']
            and pg_catalog.jsonb_typeof(item.value #> '{assignee,groupId}') = 'string'
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest entry is invalid';
    end if;

    perform 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live'
    order by assignment.role_assignment_id
    for update;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'expectedRevision', assignment.revision,
          'assignee', case
            when assignment.assignee_kind = 'organization_account' then
              pg_catalog.jsonb_build_object(
                'kind', 'organization_account',
                'organizationAccountId', assignment.organization_account_id
              )
            else pg_catalog.jsonb_build_object(
              'kind', 'group', 'groupId', assignment.group_id
            )
          end
        ) order by assignment.role_assignment_id
      ),
      '[]'::jsonb
    ) into canonical_assignments
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live';

    if manifest -> 'assignments' is distinct from canonical_assignments then
      raise exception using errcode = '40001',
        message = 'Affected assignment manifest is stale or incomplete';
    end if;
  elsif manifest is not null then
    raise exception using errcode = '22023',
      message = 'This role change must not carry an affected assignment manifest';
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision, permission.meaning_fingerprint
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision
    order by permission.entry_ordinal;
  else
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint,
      item.value ->> 'meaningFingerprint'
    from pg_catalog.jsonb_array_elements(candidate_permissions) with ordinality
      as item(value, ordinality)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by item.ordinality;
  end if;

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds,
      changed_by, changed_at, change_correlation_id
    ) values (
      target_organization_id, target_role_id, target_activation_policy_id,
      target_activation_policy_revision,
      (policy_value ->> 'maximumActivationDurationSeconds')::numeric::bigint,
      (policy_value ->> 'reasonRequired')::boolean,
      policy_value #>> '{recentAuthentication,kind}',
      case when policy_value #>> '{recentAuthentication,kind}' = 'none' then null
        else (policy_value #>>
          '{recentAuthentication,maximumAgeSeconds}')::numeric::bigint end,
      p_changed_by, operation_at, p_correlation_id
    );
  end if;

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
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification, target_assignment_policy,
    target_policy_continuity_revision, target_authority_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_role_key, target_label,
    target_description, target_source_definition_key,
    target_source_release_revision, target_source_release_version,
    target_source_validation_contract_version, target_accepted_registration_revision,
    target_template_continuity_revision,
    p_changed_by, operation_at, p_correlation_id
  );

  if current_revision.organization_id is not null then
    update vortex_access.organization_roles as stored
    set live_revision = target_role_revision,
      role_key = target_role_key
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
      and stored.live_revision = expected_role_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision changed concurrently';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    target_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_catalogue_changed'
  ) as version;

  select pg_catalog.jsonb_build_object(
    'roleId', revision.role_id,
    'organizationId', revision.organization_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'kind', revision.role_kind,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case
      when revision.assignment_policy = 'standing' then
        pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision
        )
      )
    end,
    'policyContinuityRevision', revision.policy_continuity_revision,
    'authorityContinuityRevision', revision.authority_continuity_revision,
    'lifecycle', revision.lifecycle,
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ), '[]'::jsonb),
    'createdByActorId', identity.created_by,
    'createdAt', identity.created_at,
    'changedByActorId', revision.changed_by,
    'changedAt', revision.changed_at,
    'changeCorrelationId', revision.change_correlation_id
  ) || case
    when revision.role_kind = 'application' then pg_catalog.jsonb_build_object(
      'applicationRootId', identity.application_root_id,
      'source', pg_catalog.jsonb_build_object(
        'applicationRootId', identity.application_root_id,
        'sourceRoleId', identity.source_role_id,
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', revision.source_definition_key,
          'rootId', identity.application_root_id,
          'releaseRevision', revision.source_release_revision,
          'releaseVersion', revision.source_release_version,
          'validationContractVersion', revision.source_validation_contract_version,
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        ),
        'sourceCatalogueFingerprint', registration.permission_catalogue_fingerprint,
        'acceptedRegistrationRevision', revision.accepted_registration_revision,
        'templateContinuityRevision', revision.template_continuity_revision
      )
    )
    when identity.derived_application_root_id is not null then
      pg_catalog.jsonb_build_object(
        'derivedFromTemplate', pg_catalog.jsonb_build_object(
          'applicationRootId', identity.derived_application_root_id,
          'sourceRoleId', identity.derived_source_role_id,
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', 'application',
            'definitionKey', identity.derived_source_definition_key,
            'rootId', identity.derived_application_root_id,
            'releaseRevision', identity.derived_source_release_revision,
            'releaseVersion', identity.derived_source_release_version,
            'validationContractVersion',
              identity.derived_source_validation_contract_version
          )
        )
      )
    else '{}'::jsonb
  end
  into role_result
  from vortex_access.organization_roles as identity
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = identity.organization_id
    and revision.role_id = identity.role_id
    and revision.revision = identity.live_revision
  left join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = revision.organization_id
    and registration.registration_kind = revision.source_registration_kind
    and registration.registration_owner_id = revision.application_root_id
    and registration.revision = revision.accepted_registration_revision
  left join vortex_definition.releases as source_release
    on source_release.root_id = revision.application_root_id
    and source_release.release_revision = revision.source_release_revision
    and source_release.release_version = revision.source_release_version
    and source_release.validation_contract_version = revision.source_validation_contract_version
  where identity.organization_id = target_organization_id
    and identity.role_id = target_role_id;

  if policy_value is not null then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationId', policy.organization_id,
      'roleId', policy.role_id,
      'activationPolicyId', policy.activation_policy_id,
      'revision', policy.revision,
      'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case
        when policy.authentication_requirement = 'none' then
          pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    )) into policy_result
    from vortex_access.organization_role_activation_policy_revisions as policy
    where policy.organization_id = target_organization_id
      and policy.role_id = target_role_id
      and policy.activation_policy_id = target_activation_policy_id
      and policy.revision = target_activation_policy_revision;
  end if;

  return query select 'changed'::text, operation_name, role_result,
    policy_result, next_access_version, p_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_role_change_without_stewardship_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

grant execute on function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) to postgres;

alter function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) owner to vortex_owner;


create or replace function vortex_access.project_organization_role_change_summary(
  p_organization_id uuid,
  p_role_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds',
          policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
$function$;

revoke execute on function
  vortex_access.project_organization_role_change_summary(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.project_organization_role_change_summary(uuid, uuid) is
  'Private safe current role projection for protected structural changes.';

alter function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) to postgres;


create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative,
              -- The meaning the role accepted, which may be older than the registered one.
              'recordScope', catalogue.record_scope,
              'fieldPolicy', catalogue.field_policy
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

alter function vortex_access.read_organization_role_for_administration(p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_for_administration(p_role_id uuid) to postgres;


create or replace function vortex_identity.tenant_short_name_reserved(p_short_name text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  select p_short_name = any (array['api', 'auth', 'fonts', 'health', 'signed-in', 'studio']::text[])
$function$;

alter function vortex_identity.tenant_short_name_reserved(text) owner to vortex_owner;
revoke all on function vortex_identity.tenant_short_name_reserved(text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.tenant_short_name_reserved(text) to vortex_owner, postgres;

-- Report conflicting names rather than rename tenants silently.
do $reserved_names$
declare
  names text;
begin
  select pg_catalog.string_agg(short_name, ', ' order by short_name) into names
  from vortex_identity.tenants
  where vortex_identity.tenant_short_name_reserved(short_name);
  if names is not null then
    raise exception 'Existing tenant short names are reserved for platform routes: %', names;
  end if;
end
$reserved_names$;

alter table vortex_identity.tenants add constraint tenants_short_name_not_reserved
  check (not vortex_identity.tenant_short_name_reserved(short_name));


-- Carry durable disablement commands into the shared idempotency table. A collision
-- aborts the migration rather than choosing a result from two unrelated commands.
create temporary table identity_disablement_receipt_carry on commit drop as
select command_id, actor_identity_id, subject_identity_id, requested_at
from vortex_identity.identity_disablement_commands;
grant select on identity_disablement_receipt_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
insert into vortex_record.command_receipts (
  command_id, organization_id, tenant_id, actor_id, command_kind, result, created_at
)
select command_id, null, null, actor_identity_id, 'identity_disablement',
  pg_catalog.jsonb_build_object('subjectIdentityId', subject_identity_id), requested_at
from identity_disablement_receipt_carry;
reset role;
set local role vortex_owner;
alter table vortex_identity.identity_disablement_commands drop column command_fingerprint;
comment on table vortex_identity.identity_disablement_commands is
  'Private resumable state for environment-wide identity disablement: actor, subject, command identity and current outcome; it contains no credential, token, address or profile.';
drop function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, text, uuid);

create or replace function vortex_identity.begin_identity_disablement(
  p_actor_identity_id uuid,
  p_subject_identity_id uuid,
  p_command_id uuid,
  p_correlation_id uuid
)
returns table(outcome text, sessions_revoked integer, correlation_id uuid, subject_identity_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
  claimed jsonb;
  original_subject_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or p_actor_identity_id is null or p_subject_identity_id is null
    or p_command_id is null or p_correlation_id is null then
    raise exception 'invalid identity disablement command' using errcode = '22023';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'identity_disablement', p_command_id, null, null, p_actor_identity_id,
    'Identity disablement command conflicts'
  );
  if claimed is null then
    if p_actor_identity_id = p_subject_identity_id then
      raise exception 'identity cannot disable itself' using errcode = 'V3191';
    end if;
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_command_id, pg_catalog.jsonb_build_object('subjectIdentityId', p_subject_identity_id)
    );
    insert into vortex_identity.identity_disablement_commands (
      command_id, actor_identity_id, subject_identity_id,
      correlation_id, outcome, requested_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id,
      p_correlation_id, 'started', operation_at
    );
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'started', operation_at
    );
    return query select 'started'::text, null::integer, p_correlation_id, p_subject_identity_id;
    return;
  end if;

  original_subject_id := (claimed ->> 'subjectIdentityId')::uuid;
  select recorded.* into strict existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;
  if original_subject_id is distinct from existing.subject_identity_id
    or existing.actor_identity_id is distinct from p_actor_identity_id then
    raise exception 'identity disablement workflow state is inconsistent' using errcode = '55000';
  end if;
  if existing.outcome = 'disabled' then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
    ) values (
      p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
      'replayed', operation_at
    );
    return query select 'replayed'::text, existing.sessions_revoked,
      existing.correlation_id, original_subject_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started', completed_at = null, sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;
  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event, recorded_at
  ) values (
    p_command_id, existing.actor_identity_id, original_subject_id, p_correlation_id,
    'started', operation_at
  );
  return query select 'started'::text, null::integer, existing.correlation_id, original_subject_id;
end
$function$;

alter function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) owner to vortex_owner;
comment on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) is
  'Starts or resumes the stored Identity Authority disablement subject, or replays its completed outcome.';
revoke all on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) from public;
grant execute on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, uuid) to vortex_runtime, postgres;

-- Preserve the original subject in existing super-administrator command results.
create temporary table super_administrator_assignment_carry on commit drop as
select assignment_id, identity_id from vortex_identity.vortex_super_administrator_assignments;
grant select on super_administrator_assignment_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
do $super_receipts$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.command_kind in (
      'vortex_super_administrator_bootstrap', 'vortex_super_administrator_grant',
      'vortex_super_administrator_revoke'
    ) and not exists (
      select 1 from super_administrator_assignment_carry as assignment
      where assignment.assignment_id::text = receipt.result ->> 'assignmentId'
    )
  ) then
    raise exception 'A super-administrator receipt has no assignment to preserve its identity';
  end if;
end
$super_receipts$;
update vortex_record.command_receipts as receipt
set result = (receipt.result - 'fingerprint') || pg_catalog.jsonb_build_object('identityId', assignment.identity_id)
from super_administrator_assignment_carry as assignment
where receipt.command_kind in (
    'vortex_super_administrator_bootstrap', 'vortex_super_administrator_grant',
    'vortex_super_administrator_revoke'
  ) and assignment.assignment_id::text = receipt.result ->> 'assignmentId';
reset role;
set local role vortex_owner;

create or replace function vortex_identity.bootstrap_vortex_super_administrator(
  p_operator_actor_id uuid,
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
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator bootstrap command is invalid';
  end if;

  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_bootstrap', p_duplicate_key, null, null, p_operator_actor_id,
    'Super-administrator bootstrap duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
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

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  for update;
  if found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator bootstrap is available only for the first assignment';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at,
    'configured_system_operator', p_operator_actor_id, new_correlation_id,
    evaluated_at, 'configured_system_operator', p_operator_actor_id,
    new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'identityId', p_identity_id, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid) is
  'Bootstraps the first named super-administrator assignment through the existing configured system operator.';

alter function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.bootstrap_vortex_super_administrator(p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid) to postgres;


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

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_grant', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator grant duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
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
      'identityId', p_identity_id, 'assignmentId', new_assignment_id, 'revision', 1,
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

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Multi-factor authentication is required for super-administrator changes';
  end if;


  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_revoke', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator revocation duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      (claimed ->> 'identityId')::uuid, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
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
      'identityId', target_identity_id, 'assignmentId', p_assignment_id, 'revision', resulting_revision,
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


-- Tenant lifecycle receipts previously used platform scope; retain their tenant scope
-- from the stored result before changing replay classification.
reset role;
set local role vortex_record_adapter;
do $tenant_receipts$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.command_kind in ('suspend_tenant', 'reactivate_tenant')
      and (receipt.organization_id is not null or receipt.tenant_id is not null
        or not coalesce(pg_catalog.pg_input_is_valid(receipt.result #>> '{subjectIds,0}', 'uuid'), false))
  ) then
    raise exception 'A tenant lifecycle receipt cannot preserve its original tenant scope';
  end if;
end
$tenant_receipts$;
update vortex_record.command_receipts as receipt
set tenant_id = (receipt.result #>> '{subjectIds,0}')::uuid,
  result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('suspend_tenant', 'reactivate_tenant');
reset role;
set local role vortex_owner;
drop function vortex_identity.suspend_tenant(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.reactivate_tenant(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.apply_configured_tenant_lifecycle(text, uuid, uuid, uuid, text, uuid, bigint);

create or replace function vortex_identity.apply_configured_tenant_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
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
  stored record;
  claimed jsonb;
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
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, p_operation, stored."subjectIds"[1],
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', p_tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, p_tenant_id, p_duplicate_key
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_tenant_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query select 'accepted'::text, p_operation, p_tenant_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,uuid,bigint) is 'Private exact composition for configured-system tenant suspension and reactivation.';

alter function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'suspend_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only non-cascading suspension of one active tenant.';

alter function vortex_identity.suspend_tenant(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.reactivate_tenant(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_tenant_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_tenant_lifecycle(
    'reactivate_tenant', p_cluster_id, p_operator_actor_id, p_duplicate_key,
    p_tenant_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only reactivation of one stewardship-ready suspended tenant.';

alter function vortex_identity.reactivate_tenant(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


-- Preserve the original subject and result of existing cluster identity commands.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in (
  'suspend_cluster_identity', 'reactivate_cluster_identity', 'close_cluster_identity'
);
reset role;
set local role vortex_owner;
drop function vortex_identity.suspend_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.reactivate_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.close_cluster_identity(uuid, uuid, uuid, text, uuid, bigint);
drop function vortex_identity.apply_configured_cluster_identity_lifecycle(text, uuid, uuid, uuid, text, uuid, bigint);

create or replace function vortex_identity.apply_configured_cluster_identity_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
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
  stored record;
  claimed jsonb;
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
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, p_operation, stored."subjectIds"[1],
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', affected.tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, affected.tenant_id, p_duplicate_key
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        affected.tenant_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent tenant manager is required';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_identity_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );

  return query select 'accepted'::text, p_operation, p_identity_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,uuid,bigint) is 'Private exact composition for the three configured-system cluster-local identity lifecycle commands.';

alter function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(p_operation text, p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_identity_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'suspend_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only suspension of one cluster-local identity projection.';

alter function vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.reactivate_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'reactivate_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only reactivation of one cluster-local identity projection.';

alter function vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


create or replace function vortex_identity.close_cluster_identity(
  p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid,
  p_identity_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, identity_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz)
language sql volatile security definer set search_path = ''
as $function$
  select * from vortex_identity.apply_configured_cluster_identity_lifecycle(
    'close_cluster_identity', p_cluster_id, p_operator_actor_id,
    p_duplicate_key, p_identity_id, p_expected_revision
  )
$function$;

revoke execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) is 'Configured-system-only terminal closure of one cluster-local identity projection.';

alter function vortex_identity.close_cluster_identity(uuid,uuid,uuid,uuid,bigint) owner to vortex_owner;


-- Retain the result of existing adoption and provisioning commands without input hashes.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('adopt_tenant', 'provision_tenant');
reset role;
set local role vortex_owner;
drop function vortex_identity.adopt_tenant(uuid, uuid, text, uuid, uuid);
drop function vortex_identity.provision_tenant(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text, text, text, text, text, text, text, text);

create or replace function vortex_identity.adopt_tenant(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
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
  stored record;
  claimed jsonb;
  tenant_revision bigint;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_assignment_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_steward_identity_id::text) then
    raise exception using errcode = '22023', message = 'Tenant adoption input is invalid';
  end if;

  select tenant.revision into tenant_revision
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_tenant', p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    if replay_assignment_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_tenant'::text, p_tenant_id,
      replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
        'adopt_tenant', p_tenant_id, null, p_duplicate_key
      )
      or vortex_record.command_receipt_subject_exists_internal(
        'provision_tenant', null, p_tenant_id, p_duplicate_key
      )
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );
  return query select 'accepted'::text, 'adopt_tenant'::text, p_tenant_id,
    new_assignment_id, 1::bigint, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_tenant(uuid,uuid,uuid,uuid) is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';

alter function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_tenant_steward_identity_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.adopt_tenant(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_tenant_steward_identity_id uuid) to postgres;


create or replace function vortex_identity.provision_tenant(
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
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
  p_runtime_number_format text,
  p_storage_project text
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
  stored record;
  claimed jsonb;
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
  if not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Tenant provisioning input is invalid';
  end if;

  -- The new tenant has no row to lock yet. This lock is limited to one trusted
  -- actor/cluster/duplicate tuple and exists only to converge simultaneous retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|provision_tenant|' ||
      p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'provision_tenant', p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );

  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select tenant.tenant_id into replay_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored."subjectIds");
    select organization.organization_id into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_tenant_id is null or replay_organization_id is null
      or replay_assignment_id is null or replay_account_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'provision_tenant'::text,
      replay_tenant_id, replay_organization_id, replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_account_id)],
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if p_storage_project is null or p_storage_project !~ '^[a-z0-9][a-z0-9-]{0,119}$' then
    raise exception using errcode = '22023', message = 'Storage destination is invalid';
  end if;
  insert into vortex_platform.storage_destination(singleton, project_ref)
  values (true, p_storage_project) on conflict (singleton) do nothing;
  if not exists (select 1 from vortex_platform.storage_destination where singleton and project_ref = p_storage_project) then
    raise exception using errcode = '55000', message = 'Storage destination differs from the provisioned project';
  end if;
  if vortex_identity.tenant_short_name_reserved(p_tenant_short_name) then
    raise exception using errcode = 'V3190', message = 'Tenant short name is reserved for a platform route';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  -- Reuse the organisation runtime settings language/time-zone validators for account preferences.
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

  -- The role revision check trigger is deferred. Validate it while the privileged
  -- boundary is still active so a runtime-role commit cannot bypass or fail its reads.
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
    (new_tenant_id, 1::bigint),
    (new_organization_id, resulting_access_version),
    (new_tenant_assignment_id, 1::bigint),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );

  return query select 'accepted'::text, 'provision_tenant'::text,
    new_tenant_id, new_organization_id, new_tenant_assignment_id, 1::bigint,
    new_account_id, 1::bigint, resulting_access_version,
    new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) to vortex_runtime;
comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations and an initial current owner Group membership for the organisation steward.';

alter function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) owner to vortex_owner;

grant execute on function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) to postgres;


-- The tenant administrator receipts already carry the original assignment.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in (
  'grant_tenant_administrator', 'change_tenant_administrator', 'revoke_tenant_administrator'
);
reset role;
set local role vortex_owner;
drop function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz);
drop function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz);
drop function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint);

create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
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
    or capabilities is null
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'grant_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
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
      'subjectRevisions', pg_catalog.to_jsonb(array[1::bigint])
    )
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with self-grant refusal, grantor-bounded expiry and accepted replay.';

alter function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.grant_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;


create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
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
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
    return;
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

alter function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) owner to vortex_owner;

grant execute on function vortex_identity.change_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint, p_capabilities jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone) to postgres;


create or replace function vortex_identity.revoke_tenant_administrator(
  p_duplicate_key uuid,
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
 then
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
      "subjectRevisions" bigint[]
    );
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId",
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
    )
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

alter function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.revoke_tenant_administrator(p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;


-- Organisation governance receipts were tenant-scoped. Recover the exact
-- organisation from each stored subject set, failing if it cannot be mapped.
create temporary table organization_receipt_scope_carry on commit drop as
select organization_id, tenant_id from vortex_identity.organizations;
grant select on organization_receipt_scope_carry to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
do $organization_receipts$
declare
  bad_command uuid;
begin
  select receipt.command_id into bad_command
  from vortex_record.command_receipts as receipt
  where receipt.command_kind in (
      'archive_tenant_organization', 'reactivate_tenant_organization',
      'suspend_tenant_organization', 'rename_tenant_organization',
      'reparent_tenant_organization', 'adopt_organization'
    ) and (receipt.organization_id is not null or (
      select count(*) from organization_receipt_scope_carry as organization
      where organization.tenant_id = receipt.tenant_id
        and receipt.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[organization.organization_id])
    ) <> 1)
  order by receipt.command_id limit 1;
  if bad_command is not null then
    raise exception 'Organisation scope cannot be recovered for command %', bad_command;
  end if;
end
$organization_receipts$;
update vortex_record.command_receipts as receipt
set organization_id = organization.organization_id,
  result = receipt.result - 'fingerprint' - 'clusterId'
from organization_receipt_scope_carry as organization
where receipt.command_kind in (
    'archive_tenant_organization', 'reactivate_tenant_organization',
    'suspend_tenant_organization', 'rename_tenant_organization',
    'reparent_tenant_organization', 'adopt_organization'
  ) and organization.tenant_id = receipt.tenant_id
  and receipt.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[organization.organization_id]);
reset role;
set local role vortex_owner;
drop function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint);
drop function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text);
drop function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid);
drop function vortex_identity.adopt_organization(uuid, uuid, text, uuid, uuid, uuid, uuid);

create or replace function vortex_identity.archive_tenant_organization(
  p_duplicate_key uuid,
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
  target_access_found boolean;
  target_organization_found boolean;
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
    or p_expected_revision not between 1 and 9007199254740991 then
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
  target_access_found := found;

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
  target_organization_found := found;

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
    'archive_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
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

revoke execute on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.archive_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.reactivate_tenant_organization(
  p_duplicate_key uuid,
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
  target_access_found boolean;
  target_organization_found boolean;
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
    or p_expected_revision not between 1 and 9007199254740991 then
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
  target_access_found := found;

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
  target_organization_found := found;

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
    'reactivate_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
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

revoke execute on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.reactivate_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.suspend_tenant_organization(
  p_duplicate_key uuid,
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
  target_access_found boolean;
  target_organization_found boolean;
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
    or p_expected_revision not between 1 and 9007199254740991 then
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
  target_access_found := found;

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
  target_organization_found := found;

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
    'suspend_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  if not target_access_found or not target_organization_found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
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

revoke execute on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_identity.suspend_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_identity.rename_tenant_organization(
  p_duplicate_key uuid,
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
    'rename_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
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

revoke execute on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) owner to vortex_owner;

grant execute on function vortex_identity.rename_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_display_name text) to postgres;


create or replace function vortex_identity.reparent_tenant_organization(
  p_duplicate_key uuid,
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
    'reparent_tenant_organization', p_duplicate_key, p_organization_id, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
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
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision])
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

revoke execute on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.reparent_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_expected_revision bigint, p_parent_organization_id uuid) to postgres;


create or replace function vortex_identity.adopt_organization(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
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
  stored record;
  claimed jsonb;
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
  replay_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_steward_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text) then
    raise exception using errcode = '22023', message = 'Organization adoption input is invalid';
  end if;

  -- Keep Access before Identity without creating state or refusing a replay.
  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_organization', p_duplicate_key, p_organization_id, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = any(stored."subjectIds");
    if replay_account_id is null then
      raise exception using errcode = '55000', message = 'Stored adoption result is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_organization'::text,
      p_tenant_id, p_organization_id, replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
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


  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
      'adopt_organization', p_tenant_id, p_organization_id, p_duplicate_key
    )
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

  select current_requirement.* into requirement
  from vortex_access.organization_stewardship_requirements as current_requirement
  where current_requirement.organization_id = p_organization_id
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

  -- The role revision check trigger is deferred. Validate it while the privileged
  -- boundary is still active so a runtime-role commit cannot bypass or fail its reads.
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
    (p_organization_id, resulting_access_version),
    (p_organization_account_id, account_revision)
  ) as result(subject_id, subject_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );
  return query select 'accepted'::text, 'adopt_organization'::text,
    p_tenant_id, p_organization_id, p_organization_account_id,
    resulting_access_version, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_organization(uuid,uuid,uuid,uuid,uuid,uuid) is 'Configured-system-only explicit organisation stewardship adoption through the existing Access coordinator.';

alter function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.adopt_organization(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid, p_steward_identity_id uuid, p_organization_account_id uuid) to postgres;


-- Organisation creation stays tenant-scoped; its stored subject set supplies the result.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind = 'create_tenant_organization';
reset role;
set local role vortex_owner;
drop function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text);

create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
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
      "subjectRevisions" bigint[]
    );
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

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );


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
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
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

revoke execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;

grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;

CREATE OR REPLACE FUNCTION vortex_identity.protect_identity_disablement_command() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'identity disablement records are append-only'
      using errcode = '55000';
  end if;
  if new.command_id is distinct from old.command_id
    or new.actor_identity_id is distinct from old.actor_identity_id
    or new.subject_identity_id is distinct from old.subject_identity_id
    or new.correlation_id is distinct from old.correlation_id
    or new.requested_at is distinct from old.requested_at
    or old.outcome = 'disabled'
  then
    raise exception 'a recorded identity disablement command identity and result are immutable'
      using errcode = '55000';
  end if;
  return new;
end
$$;

alter function vortex_identity.protect_identity_disablement_command() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_identity_disablement_command() FROM PUBLIC;

grant execute on function vortex_identity.protect_identity_disablement_command() to postgres;

-- Administration receipts already store the organisation and original subject.
reset role;
set local role vortex_record_adapter;
update vortex_record.command_receipts as receipt
set result = receipt.result - 'fingerprint' - 'clusterId'
where receipt.command_kind in ('create_organization_invitation', 'revoke_organization_invitation', 'close_organization_account', 'reactivate_organization_account', 'suspend_organization_account');
reset role;
set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
  role_item record; role_intents jsonb := '[]'::jsonb;
  locked_version bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_role_ids is null or pg_catalog.cardinality(p_role_ids) = 0
    or exists (select 1 from pg_catalog.unnest(p_role_ids) as id where id is null or not vortex_platform.is_non_nil_uuid(id::text))
    or pg_catalog.cardinality(p_role_ids) <> (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_role_ids) as id) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select version.current_version into locked_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id for update;
  if locked_version is distinct from scope.access_version then
    raise exception using errcode = '40001', message = 'Invitation authority is stale';
  end if;
  for role_item in
    select role.role_id, role.live_revision, revision.lifecycle, revision.assignment_policy
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
    order by role.role_id for update of role
  loop
    if role_item.lifecycle <> 'active' or role_item.assignment_policy not in ('standing', 'activation_required')
      or not vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role_item.role_id, operation_at
      ) then
      raise exception using errcode = 'V3145', message = 'You cannot give this role';
    end if;
    role_intents := role_intents || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'roleId', role_item.role_id, 'roleRevision', role_item.live_revision
    ));
  end loop;
  if pg_catalog.jsonb_array_length(role_intents) <> pg_catalog.cardinality(p_role_ids) then
    raise exception using errcode = 'V3145', message = 'You cannot give this role';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at, role_intents
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) IS 'Protected role-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) to postgres;


CREATE OR REPLACE FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  new_receipt_id uuid; new_accepted_at timestamptz;
  revoked record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invitation revocation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  if p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Invitation revocation is stale or unavailable';
  end if;
  select result.* into strict revoked
  from vortex_identity.revoke_organization_invitation(
    p_invitation_id, p_expected_revision
  ) as result;
  if revoked.organization_id <> scope.organization_id
    or revoked.invitation_id <> p_invitation_id
    or revoked.revision <> p_expected_revision + 1
    or revoked.accepted_at is not null or revoked.revoked_at is null
    or revoked.revoked_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation revocation result is unavailable';
  end if;
  if scope.organization_id < p_invitation_id then
    subject_ids := array[scope.organization_id, p_invitation_id];
    subject_revisions := array[scope.access_version, revoked.revision];
  else
    subject_ids := array[p_invitation_id, scope.organization_id];
    subject_revisions := array[revoked.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := revoked.changed_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$$;

alter function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) IS 'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';

REVOKE ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) TO vortex_request;

grant execute on function vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.close_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closure command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'close_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account closure receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'close_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('active', 'suspended')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closure is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'closed'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closed' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closure result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'close_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';

revoke execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.close_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.reactivate_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account reactivation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account reactivation receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'reactivate_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account reactivation is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'active'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'active' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account reactivation result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'reactivate_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected suspended-or-closed-to-active account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.reactivate_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;


create or replace function vortex_access.suspend_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  replay_target_id uuid;
  target record; changed record;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds")
      then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    replay_target_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, replay_target_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_target_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state <> 'active' or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account suspension is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'suspended'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'suspended' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account suspension result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

alter function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.suspend_organization_account_for_administration(p_duplicate_key uuid, p_organization_account_id uuid, p_expected_revision bigint) to postgres;



-- Remove the unconsumed capability policy, reservation and usage projection stack.
drop table vortex_access.capability_limit_changes;
drop table vortex_access.capability_reservation_balances;
drop table vortex_access.capability_reservations;
drop table vortex_access.capability_policy_assignments;
drop table vortex_access.capability_policy_definitions;
drop table vortex_access.usage_projection_reconciliation;
drop table vortex_access.usage_projection_rollups;
drop function vortex_access.capability_limit_bounds_internal(uuid,uuid,text,text,timestamp with time zone,boolean);
drop function vortex_access.capability_reservation_request_context(uuid,uuid);
drop function vortex_access.consume_capability_reservation(uuid,uuid,text,text,uuid,bigint,uuid,bigint,uuid,numeric,uuid);
drop function vortex_access.derive_usage_projection(uuid,timestamp with time zone,timestamp with time zone);
drop function vortex_access.expire_stale_capability_reservations(uuid,uuid,text,text);
drop function vortex_access.lock_effective_capability_policy(uuid,uuid,text,text,timestamp with time zone);
drop function vortex_access.publish_capability_policy_definition(uuid,uuid,uuid,uuid,text,text,numeric,bigint);
drop function vortex_access.read_capability_reservation_balance(uuid,uuid,text,text);
drop function vortex_access.read_usage_projection(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text,integer,text);
drop function vortex_access.rebuild_usage_projection(uuid,uuid,timestamp with time zone,timestamp with time zone);
drop function vortex_access.refresh_capability_reservation_balance(uuid,uuid,text,text,text,uuid,uuid,bigint,uuid,bigint,numeric,timestamp with time zone);
drop function vortex_access.refuse_capability_limit_change_edit();
drop function vortex_access.release_capability_reservation(uuid,uuid,text,text,uuid,bigint,uuid,bigint,uuid,uuid,numeric);
drop function vortex_access.reserve_capability_quantity(uuid,uuid,text,text,jsonb,numeric,uuid);
drop function vortex_access.resolve_effective_capability_policy(uuid,uuid,text,text);
drop function vortex_access.revoke_capability_limit_allocation(uuid,uuid,uuid,uuid,bigint,uuid);
drop function vortex_access.revoke_capability_policy_ceiling(uuid,uuid,uuid,uuid,bigint);
drop function vortex_access.set_capability_limit_allocation(uuid,uuid,uuid,uuid,text,text,numeric,timestamp with time zone,bigint,uuid);
drop function vortex_access.set_capability_policy_ceiling(uuid,uuid,uuid,uuid,uuid,bigint,timestamp with time zone,timestamp with time zone,bigint);


-- Preserve the old integrity check for current pending proposals before removing hashes.
do $preflight$
declare
  bad_grant uuid;
  bad_organization uuid;
begin
  select grant_row.grant_id, grant_row.source_organization_id
  into bad_grant, bad_organization
  from vortex_access.record_share_grants as grant_row
  join vortex_access.record_share_grant_consent_requests as request_row
    on request_row.request_id = grant_row.consent_request_id
  where grant_row.status = 'pending_consent'
    and (request_row.revision is distinct from grant_row.revision
      or request_row.proposed_grant_fingerprint is distinct from grant_row.proposal_fingerprint
      or exists (
        select 1 from vortex_access.record_share_grant_consent_decisions as decision_row
        where decision_row.request_id = request_row.request_id
          and decision_row.proposal_revision = grant_row.revision
          and decision_row.proposed_grant_fingerprint is distinct from grant_row.proposal_fingerprint
      ))
  limit 1;
  if found then
    raise exception using errcode = '23514',
      message = pg_catalog.format('share_proposal_revision_mismatch: organization %s grant %s',
        bad_organization, bad_grant);
  end if;
end
$preflight$;

-- Consent evidence names the existing grant revision instead of a duplicate hash.
drop function vortex_access.propose_record_share_grant_for_administration(uuid, uuid, jsonb, text, uuid);
drop function vortex_access.revise_record_share_grant_for_administration(uuid, bigint, jsonb, text, uuid);
drop function vortex_access.record_share_grant_consent_decision_for_administration(uuid, uuid, bigint, text, text, text, uuid);
alter table vortex_access.record_share_grant_consent_decisions drop column proposed_grant_fingerprint;
alter table vortex_access.record_share_grant_consent_requests drop column proposed_grant_fingerprint;
alter table vortex_access.record_share_grants drop column proposal_fingerprint;

CREATE OR REPLACE FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  stored vortex_access.record_share_grants%rowtype;
  consent vortex_access.record_share_grant_consent_requests%rowtype;
  grant_json jsonb;
  consent_json jsonb := null;
begin
  select grants.* into strict stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id;

  grant_json := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'scopeKind', stored.scope_kind,
    'grantId', stored.grant_id,
    'sourceClusterId', stored.source_cluster_id,
    'sourceOrganizationId', stored.source_organization_id,
    'sourceApplicationRootId', stored.source_application_root_id,
    'recipientClusterId', stored.recipient_cluster_id,
    'recipientOrganizationId', stored.recipient_organization_id,
    'recipientApplicationRootId', stored.recipient_application_root_id,
    'readableFieldIds', pg_catalog.to_jsonb(stored.readable_field_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(stored.changeable_field_ids),
    'recipientRoleIds', pg_catalog.to_jsonb(stored.recipient_role_ids),
    'moduleRootId', stored.module_root_id,
    'allowedActionKeys', pg_catalog.to_jsonb(stored.allowed_action_keys),
    'exportAllowed', stored.export_allowed,
    'approvedRecipientRegion', stored.approved_recipient_region,
    'startsAt', pg_catalog.to_char(
      stored.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', case when stored.expires_at is null then null else pg_catalog.to_char(
      stored.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'status', stored.status,
    'createdByOrganizationAccountId', stored.created_by_organization_account_id,
    'consentRequestId', stored.consent_request_id,
    'contractVersion', stored.contract_version,
    'contractFingerprint', stored.contract_fingerprint,
    'recipientBindingId', stored.recipient_binding_id,
    'definitionMappingFingerprint', stored.definition_mapping_fingerprint,
    'recordTypeId', stored.record_type_id,
    'recordId', stored.record_id,
    'savedConditionId', stored.saved_condition_id,
    'savedConditionRevision', stored.saved_condition_revision,
    'savedConditionFingerprint', stored.saved_condition_fingerprint,
    'revokedAt', case when stored.revoked_at is null then null else pg_catalog.to_char(
      stored.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'revokedByOrganizationAccountId', stored.revoked_by_organization_account_id,
    'revocationReason', stored.revocation_reason
  ))
  -- Parameters are added after null stripping so a saved condition's exact
  -- parameter object survives unchanged.
  || case when stored.scope_kind = 'saved_condition'
    then pg_catalog.jsonb_build_object('parameters', stored.saved_condition_parameters)
    else '{}'::jsonb end;

  if stored.consent_request_id is not null then
    select requests.* into strict consent
    from vortex_access.record_share_grant_consent_requests as requests
    where requests.request_id = stored.consent_request_id;
    consent_json := pg_catalog.jsonb_build_object(
      'requestId', consent.request_id,
      'sourceOrganizationId', consent.source_organization_id,
      'sourceClusterId', consent.source_cluster_id,
      'recipientOrganizationId', consent.recipient_organization_id,
      'recipientClusterId', consent.recipient_cluster_id,
      'status', consent.status,
      'requestedByOrganizationAccountId', consent.requested_by_organization_account_id,
      'requestedAt', pg_catalog.to_char(
        consent.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'requiredDecisions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'side', 'source_authorization',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.source_authorizing_role_ids)
        ),
        pg_catalog.jsonb_build_object(
          'side', 'recipient_acceptance',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.recipient_accepting_role_ids)
        )
      ),
      'expiresAt', pg_catalog.to_char(
        consent.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'grant', grant_json,
    'consentRequest', consent_json,
    'revision', stored.revision,
    'changedAt', pg_catalog.to_char(
      stored.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$$;

alter function vortex_access.record_share_grant_json_internal(p_grant_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) FROM PUBLIC;

grant execute on function vortex_access.record_share_grant_json_internal(p_grant_id uuid) to postgres;

create or replace function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
  p_activity_id uuid
)
returns jsonb
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
  context_application_root_id uuid;
  locked_access_version bigint;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or (p_consent_request_id is not null
      and p_consent_request_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal requires an application context';
  end if;

  -- Take the organisation's shared Access lock before evaluating any authority, so a
  -- concurrent authority change cannot land between the check and the write.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal is unavailable';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  if vortex_access.recent_authentication_deadline_internal(
    context_value, pg_catalog.clock_timestamp(),
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share grant administration requires multi-factor authentication';
  end if;

  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (p_consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  insert into vortex_access.record_share_grants (
    grant_id, source_organization_id, source_cluster_id, source_application_root_id,
    recipient_cluster_id, recipient_organization_id, recipient_application_root_id,
    scope_kind, module_root_id, record_type_id, record_id, saved_condition_id,
    saved_condition_revision, saved_condition_fingerprint, saved_condition_parameters,
    readable_field_ids, changeable_field_ids, recipient_role_ids, allowed_action_keys,
    export_allowed, approved_recipient_region, starts_at, expires_at, status,
    created_by_organization_account_id, consent_request_id, contract_version,
    contract_fingerprint, recipient_binding_id, definition_mapping_fingerprint,
    revision, created_at, changed_at
  ) values (
    p_grant_id, context_organization_id, (p_terms ->> 'sourceClusterId')::uuid,
    context_application_root_id, (p_terms ->> 'recipientClusterId')::uuid,
    (p_terms ->> 'recipientOrganizationId')::uuid,
    (p_terms ->> 'recipientApplicationRootId')::uuid,
    p_terms ->> 'scopeKind', (p_terms ->> 'moduleRootId')::uuid,
    (p_terms ->> 'recordTypeId')::uuid, (p_terms ->> 'recordId')::uuid,
    (p_terms ->> 'savedConditionId')::uuid, (p_terms ->> 'savedConditionRevision')::bigint,
    p_terms ->> 'savedConditionFingerprint', p_terms -> 'parameters',
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'readableFieldIds', 1, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'changeableFieldIds', 0, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'recipientRoleIds', 1, 100),
    array(select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
    (p_terms ->> 'exportAllowed')::boolean, p_terms ->> 'approvedRecipientRegion',
    (p_terms ->> 'startsAt')::timestamptz, (p_terms ->> 'expiresAt')::timestamptz,
    case when cross_organization then 'pending_consent' else 'draft' end,
    context_account_id, p_consent_request_id, p_terms ->> 'contractVersion',
    p_terms ->> 'contractFingerprint', (p_terms ->> 'recipientBindingId')::uuid,
    p_terms ->> 'definitionMappingFingerprint', 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid,
      'pending', context_account_id, now_value,
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientAcceptingRoleIds', 1, 100),
      (p_terms ->> 'expiresAt')::timestamptz, 1, now_value
    );
  end if;


  append_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'propose_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant proposal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal revision.';

alter function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.propose_record_share_grant_for_administration(p_grant_id uuid, p_consent_request_id uuid, p_terms jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.revise_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_terms jsonb,
  p_activity_id uuid
)
returns jsonb
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
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;

  -- Only the source organisation's own application may revise its proposal; a
  -- foreign or unknown grant is indistinguishable from a missing one.
  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  if vortex_access.recent_authentication_deadline_internal(
    context_value, pg_catalog.clock_timestamp(),
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share grant administration requires multi-factor authentication';
  end if;

  -- A revision cannot turn a same-organisation proposal into a cross-organisation
  -- one or back: consent is bound to the grant's recipient organisation.
  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (stored.consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  update vortex_access.record_share_grants as grants
  set source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
      recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
      recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
      recipient_application_root_id = (p_terms ->> 'recipientApplicationRootId')::uuid,
      scope_kind = p_terms ->> 'scopeKind',
      module_root_id = (p_terms ->> 'moduleRootId')::uuid,
      record_type_id = (p_terms ->> 'recordTypeId')::uuid,
      record_id = (p_terms ->> 'recordId')::uuid,
      saved_condition_id = (p_terms ->> 'savedConditionId')::uuid,
      saved_condition_revision = (p_terms ->> 'savedConditionRevision')::bigint,
      saved_condition_fingerprint = p_terms ->> 'savedConditionFingerprint',
      saved_condition_parameters = p_terms -> 'parameters',
      readable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'readableFieldIds', 1, 500),
      changeable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'changeableFieldIds', 0, 500),
      recipient_role_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientRoleIds', 1, 100),
      allowed_action_keys = array(
        select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
      export_allowed = (p_terms ->> 'exportAllowed')::boolean,
      approved_recipient_region = p_terms ->> 'approvedRecipientRegion',
      starts_at = (p_terms ->> 'startsAt')::timestamptz,
      expires_at = (p_terms ->> 'expiresAt')::timestamptz,
      contract_version = p_terms ->> 'contractVersion',
      contract_fingerprint = p_terms ->> 'contractFingerprint',
      recipient_binding_id = (p_terms ->> 'recipientBindingId')::uuid,
      definition_mapping_fingerprint = p_terms ->> 'definitionMappingFingerprint',
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  -- The consent request follows the new revision and roles; earlier decisions
  -- name the previous revision and cannot approve this proposal.
  if cross_organization then
    update vortex_access.record_share_grant_consent_requests as requests
    set recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
        recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
        source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
        status = 'pending',
        requested_by_organization_account_id = context_account_id,
        requested_at = now_value,
        source_authorizing_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
        recipient_accepting_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'recipientAcceptingRoleIds', 1, 100),
        expires_at = (p_terms ->> 'expiresAt')::timestamptz,
        revision = requests.revision + 1,
        changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'revise_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_platform.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant revision Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) to vortex_request;

comment on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, uuid
) is
  'Fixed protected reviser: replaces the terms of a draft or pending_consent proposal under an exact expected revision, re-checking current share authority and resetting its consent request.';

alter function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_record_share_grant_for_administration(p_grant_id uuid, p_expected_revision bigint, p_terms jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.record_share_grant_consent_decision_for_administration(
  p_decision_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_decision text,
  p_note text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_tenant_id uuid;
  context_organization_id uuid;
  context_account_id uuid;
  context_application_root_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_multi_factor_at timestamptz;
  authentication_expires_at timestamptz;
  locked_access_version bigint;
  current_access_version bigint;
  lock_organization_id uuid;
  pre_source_organization_id uuid;
  pre_source_application_root_id uuid;
  pre_recipient_organization_id uuid;
  pre_recipient_application_root_id uuid;
  registration_target record;
  stored_grant vortex_access.record_share_grants%rowtype;
  stored_request vortex_access.record_share_grant_consent_requests%rowtype;
  source_tenant_id uuid;
  recipient_tenant_id uuid;
  side_value text;
  role_ids uuid[];
  checked_at timestamptz;
  path_checked_at timestamptz;
  authorization_path jsonb;
  path_valid_until timestamptz;
  source_authority jsonb;
  readable_ceiling uuid[];
  changeable_ceiling uuid[];
  decision_expires_at timestamptz;
  inserted_decision_id uuid;
  activity_result text;
begin
  if p_decision_id is null
    or p_decision_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_request_id is null
    or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_decision is null
    or p_decision not in ('consented', 'refused')
    or (p_note is not null and pg_catalog.char_length(p_note) > 500)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share consent decision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_tenant_id := (context_value ->> 'tenantId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_multi_factor_at :=
    (context_value ->> 'multiFactorAuthenticatedAt')::timestamptz;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is unavailable';
  end if;

  select grants.source_organization_id, grants.source_application_root_id,
    grants.recipient_organization_id, grants.recipient_application_root_id
  into pre_source_organization_id, pre_source_application_root_id,
    pre_recipient_organization_id, pre_recipient_application_root_id
  from vortex_access.record_share_grants as grants
  join vortex_access.record_share_grant_consent_requests as requests
    on requests.request_id = grants.consent_request_id
    and requests.grant_id = grants.grant_id
  where requests.request_id = p_request_id;
  if not found
    or pre_source_organization_id is null
    or pre_source_application_root_id is null
    or pre_recipient_organization_id is null
    or pre_recipient_application_root_id is null
    or pre_source_organization_id = pre_recipient_organization_id
    or context_organization_id not in (
      pre_source_organization_id, pre_recipient_organization_id
    ) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  -- The human scope resolver already holds the caller's Access-version row
  -- FOR SHARE. Lock both participant versions by organisation ID, then
  -- exact application registrations by (organisation ID, application root ID).
  -- FOR SHARE is the weakest lock that blocks non-key updates. NOWAIT avoids a
  -- cross-side deadlock when the preheld caller row reverses UUID order; SQLSTATE
  -- 55P03 becomes a retryable unavailable result at the service boundary.
  for lock_organization_id in
    select participant.organization_id
    from (values
      (pre_source_organization_id),
      (pre_recipient_organization_id)
    ) as participant(organization_id)
    order by participant.organization_id
  loop
    select version.current_version into current_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = lock_organization_id
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
    if lock_organization_id = context_organization_id then
      locked_access_version := current_access_version;
    end if;
  end loop;
  if locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  for registration_target in
    select participant.organization_id, participant.application_root_id
    from (values
      (pre_source_organization_id, pre_source_application_root_id),
      (pre_recipient_organization_id, pre_recipient_application_root_id)
    ) as participant(organization_id, application_root_id)
    order by participant.organization_id, participant.application_root_id
  loop
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = registration_target.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = registration_target.application_root_id
      and registration.state = 'active'
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent application is unavailable';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id in (
      pre_source_organization_id, pre_recipient_organization_id
    )
      and organization.state = 'active'
      and tenant.state = 'active'
  ) <> 2 then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select grants.* into stored_grant
  from vortex_access.record_share_grants as grants
  where grants.consent_request_id = p_request_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select requests.* into stored_request
  from vortex_access.record_share_grant_consent_requests as requests
  where requests.request_id = p_request_id
    and requests.grant_id = stored_grant.grant_id
  for update;
  if not found
    or stored_grant.revision <> p_expected_revision
    or stored_request.revision <> p_expected_revision
    or stored_grant.status <> 'pending_consent'
    or stored_request.status <> 'pending'
    or stored_grant.consent_request_id is distinct from stored_request.request_id
    or stored_grant.source_organization_id is distinct from
      stored_request.source_organization_id
    or stored_grant.source_organization_id is distinct from
      pre_source_organization_id
    or stored_grant.source_cluster_id is distinct from
      stored_request.source_cluster_id
    or stored_grant.source_application_root_id is distinct from
      pre_source_application_root_id
    or stored_grant.recipient_organization_id is distinct from
      stored_request.recipient_organization_id
    or stored_grant.recipient_organization_id is distinct from
      pre_recipient_organization_id
    or stored_grant.recipient_cluster_id is distinct from
      stored_request.recipient_cluster_id
    or stored_grant.recipient_application_root_id is distinct from
      pre_recipient_application_root_id
    or stored_grant.expires_at is distinct from stored_request.expires_at
    or stored_grant.source_organization_id = stored_grant.recipient_organization_id
    or stored_grant.source_cluster_id is distinct from stored_grant.recipient_cluster_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is stale or unavailable';
  end if;

  if context_organization_id = stored_grant.source_organization_id then
    side_value := 'source_authorization';
    role_ids := stored_request.source_authorizing_role_ids;
    if context_application_root_id is distinct from
      stored_grant.source_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  elsif context_organization_id = stored_grant.recipient_organization_id then
    side_value := 'recipient_acceptance';
    role_ids := stored_request.recipient_accepting_role_ids;
    if context_application_root_id is distinct from
      stored_grant.recipient_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  else
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select source.tenant_id, recipient.tenant_id
  into source_tenant_id, recipient_tenant_id
  from vortex_identity.organizations as source
  join vortex_identity.tenants as source_tenant
    on source_tenant.tenant_id = source.tenant_id
    and source_tenant.state = 'active'
  join vortex_identity.organizations as recipient
    on recipient.organization_id = stored_grant.recipient_organization_id
    and recipient.state = 'active'
  join vortex_identity.tenants as recipient_tenant
    on recipient_tenant.tenant_id = recipient.tenant_id
    and recipient_tenant.state = 'active'
  where source.organization_id = stored_grant.source_organization_id
    and source.state = 'active';
  if not found
    or (side_value = 'source_authorization'
      and source_tenant_id is distinct from context_tenant_id)
    or (side_value = 'recipient_acceptance'
      and recipient_tenant_id is distinct from context_tenant_id) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  path_checked_at := pg_catalog.clock_timestamp();
  authentication_expires_at := vortex_access.recent_authentication_deadline_internal(
    context_value, path_checked_at,
    '{"kind":"multi_factor","maximumAgeSeconds":300}'::jsonb
  );
  if authentication_expires_at is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share consent requires recent multi-factor authentication';
  end if;
  if stored_grant.expires_at is null
    or stored_grant.expires_at <= path_checked_at
    or stored_request.expires_at <= path_checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  authorization_path :=
    vortex_access.record_share_grant_consent_role_path_internal(
      context_organization_id,
      context_account_id,
      context_application_root_id,
      role_ids,
      path_checked_at,
      context_expires_at
    );
  if authorization_path is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent role path is unavailable';
  end if;
  path_valid_until := (authorization_path ->> 'validUntil')::timestamptz;

  if side_value = 'source_authorization' then
    source_authority :=
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored_grant.module_root_id, stored_grant.record_type_id
      );
    if source_authority is null
      or pg_catalog.jsonb_typeof(source_authority -> 'recordTypeIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(source_authority -> 'recordTypeIds') = 0
      or pg_catalog.jsonb_typeof(source_authority -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(source_authority -> 'changeableFieldIds') is distinct from 'array' then
      raise exception using errcode = '42501',
        message = 'Record-share consent requires current source share permission';
    end if;
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into readable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'readableFieldIds'
    ) as field(value);
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into changeable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'changeableFieldIds'
    ) as field(value);
    if not (stored_grant.readable_field_ids <@ readable_ceiling)
      or not (stored_grant.changeable_field_ids <@ changeable_ceiling) then
      raise exception using errcode = '42501',
        message = 'Record-share consent exceeds current source field authority';
    end if;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  authentication_expires_at := vortex_access.recent_authentication_deadline_internal(
    context_value, checked_at,
    '{"kind":"multi_factor","maximumAgeSeconds":300}'::jsonb
  );
  if authentication_expires_at is null then
    raise exception using errcode = 'V3152',
      message = 'Record-share consent requires recent multi-factor authentication';
  end if;
  if stored_grant.expires_at <= checked_at
    or stored_request.expires_at <= checked_at
    or path_valid_until <= checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  decision_expires_at := least(
    authentication_expires_at,
    path_valid_until,
    stored_grant.expires_at,
    stored_request.expires_at
  );

  insert into vortex_access.record_share_grant_consent_decisions (
    decision_id,
    request_id,
    grant_id,
    tenant_id,
    source_organization_id,
    recipient_organization_id,
    side,
    approver_organization_id,
    approver_organization_account_id,
    approver_application_root_id,
    proposal_revision,
    proposal_expires_at,
    access_version,
    decision,
    note,
    authorization_path,
    multi_factor_authenticated_at,
    multi_factor_authentication_expires_at,
    decided_at,
    expires_at,
    correlation_id
  ) values (
    p_decision_id,
    stored_request.request_id,
    stored_grant.grant_id,
    context_tenant_id,
    stored_grant.source_organization_id,
    stored_grant.recipient_organization_id,
    side_value,
    context_organization_id,
    context_account_id,
    context_application_root_id,
    stored_grant.revision,
    stored_grant.expires_at,
    locked_access_version,
    p_decision,
    p_note,
    authorization_path,
    context_multi_factor_at,
    authentication_expires_at,
    checked_at,
    decision_expires_at,
    context_correlation_id
  )
  on conflict (request_id, proposal_revision, side) do nothing
  returning decision_id into inserted_decision_id;
  if not found or inserted_decision_id is distinct from p_decision_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is already recorded or unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id,
    p_activity_id,
    checked_at,
    'organization_account',
    context_account_id,
    'record_share_consent_decision',
    array[stored_grant.grant_id, stored_request.request_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    context_correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share consent decision Activity is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'decisionId', p_decision_id,
    'requestId', stored_request.request_id,
    'side', side_value,
    'proposalRevision', stored_grant.revision,
    'approverOrganizationId', context_organization_id,
    'approverOrganizationAccountId', context_account_id,
    'approverApplicationRootId', context_application_root_id,
    'accessVersion', locked_access_version,
    'proposalExpiresAt', pg_catalog.to_char(
      stored_grant.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'decision', p_decision,
    'decidedAt', pg_catalog.to_char(
      checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'authorizationPath', authorization_path,
    'authenticationStrength', 'recent_multi_factor',
    'multiFactorAuthenticatedAt', pg_catalog.to_char(
      context_multi_factor_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'multiFactorAuthenticationExpiresAt', pg_catalog.to_char(
      authentication_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', pg_catalog.to_char(
      decision_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_id
  ) || case when p_note is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('note', p_note) end;
end
$function$;

revoke all on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) to vortex_request;

comment on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, uuid
) is
  'Fixed protected same-cluster consent writer: records one immutable side decision for the locked current proposal, requiring current named role-path evidence, source share and field authority where applicable and MFA no older than 300 seconds; it never activates a grant.';

alter function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_decision text, p_note text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(p_decision_id uuid, p_request_id uuid, p_expected_revision bigint, p_decision text, p_note text, p_activity_id uuid) to postgres;


-- Metering rows are durable product evidence; their UUID is their replay identity.
drop function vortex_access.record_metering_event(uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz, uuid, text, uuid, uuid, text);
alter table vortex_access.metering_events drop constraint metering_events_result_valid;
alter table vortex_access.metering_events disable trigger metering_events_immutable;
update vortex_access.metering_events set result = result - 'duplicateProtectionKey';
alter table vortex_access.metering_events enable trigger metering_events_immutable;
alter table vortex_access.metering_events drop column duplicate_protection_key;
alter table vortex_access.metering_events drop column command_fingerprint;
alter table vortex_access.metering_events add constraint metering_events_result_valid check (
  pg_catalog.jsonb_typeof(result) = 'object'
  and result ?& array['meteringEventId', 'operationId', 'tenantId', 'allocationOwner',
    'capabilityKey', 'quantity', 'unit', 'occurredAt', 'source', 'dimensions',
    'correlationId', 'acceptedAt']
  and (result ->> 'meteringEventId')::uuid is not distinct from metering_event_id
  and (result ->> 'operationId')::uuid is not distinct from operation_id
  and (result ->> 'tenantId')::uuid is not distinct from tenant_id
  and (result ->> 'organizationId')::uuid is not distinct from organization_id
  and (result ->> 'quantity')::numeric is not distinct from quantity
  and (result ->> 'correctsMeteringEventId')::uuid is not distinct from corrects_metering_event_id
  and result ->> 'correctionDirection' is not distinct from correction_direction
);
comment on table vortex_access.metering_events is
  'Immutable generic usage evidence keyed by event identity; corrections are later linked events.';

create or replace function vortex_access.record_metering_event(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_allocation_owner text,
  p_operation_id uuid,
  p_capability_key text,
  p_quantity numeric,
  p_unit text,
  p_source text,
  p_dimensions jsonb,
  p_occurred_at timestamptz,
  p_source_event_id uuid,
  p_metering_event_id uuid,
  p_correlation_id uuid,
  p_corrects_metering_event_id uuid,
  p_correction_direction text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  accepted_at_value timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  existing vortex_access.metering_events%rowtype;
  corrected vortex_access.metering_events%rowtype;
  corrected_remaining numeric;
  safe_event jsonb;
begin
  if p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_organization_id::text))
    or p_allocation_owner is null
    or p_allocation_owner not in ('local', 'federated_source', 'federated_recipient')
    or p_operation_id is null or not vortex_platform.is_non_nil_uuid(p_operation_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_source is null
    or p_source not in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
    or not vortex_access.metering_event_dimensions_are_valid(p_dimensions)
    or p_occurred_at is null
    or p_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_source_event_id is not null
      and not vortex_platform.is_non_nil_uuid(p_source_event_id::text))
    or p_metering_event_id is null
    or not vortex_platform.is_non_nil_uuid(p_metering_event_id::text)
    or p_correlation_id is null
    or not vortex_platform.is_non_nil_uuid(p_correlation_id::text)
    or (p_corrects_metering_event_id is not null
      and not vortex_platform.is_non_nil_uuid(p_corrects_metering_event_id::text))
    or ((p_corrects_metering_event_id is null) <> (p_correction_direction is null))
    or (p_correction_direction is not null
      and p_correction_direction not in ('increase', 'decrease')) then
    raise exception using errcode = '22023', message = 'Metering event command is invalid';
  end if;
  if (p_source = 'federation'
      and p_allocation_owner not in ('federated_source', 'federated_recipient'))
    or (p_source <> 'federation' and p_allocation_owner <> 'local') then
    raise exception using errcode = '22023', message = 'Metering event allocation is invalid';
  end if;
  established := vortex_platform.current_context();
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (established ->> 'organizationId')::uuid is distinct from p_organization_id
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  -- Corrections and non-web sources are system operations. A human, federated
  -- or public request context can never fabricate system/federation usage or
  -- reduce recorded usage.
  if (established ->> 'callerKind') is distinct from 'system'
    and (p_source <> 'web' or p_corrects_metering_event_id is not null) then
    raise exception using errcode = '42501',
      message = 'Metering event authority is unavailable';
  end if;
  -- Key-share locks keep the attributed scope present without serialising the
  -- tenant's other writes behind every metered operation.
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
  end if;
  -- The caller-minted event identity is the durable duplicate key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_metering_event_id::text, 751)
  );
  select stored.* into existing
  from vortex_access.metering_events as stored
  where stored.metering_event_id = p_metering_event_id;
  if found then
    if existing.tenant_id is distinct from p_tenant_id
      or existing.organization_id is distinct from p_organization_id then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
    return query select pg_catalog.jsonb_build_object(
      'status', 'replayed', 'event', existing.result
    );
    return;
  end if;
  -- Second lock, always taken after the event identity lock: an original serialises
  -- on its final operation identity, a correction on the event it corrects.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      case when p_corrects_metering_event_id is null then
        pg_catalog.concat_ws(E'\x1f', 'operation', p_tenant_id::text,
          p_operation_id::text, p_capability_key, p_unit)
      else
        pg_catalog.concat_ws(E'\x1f', 'correction', p_tenant_id::text,
          p_corrects_metering_event_id::text)
      end, 751)
  );
  if p_corrects_metering_event_id is null then
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.operation_id = p_operation_id
        and stored.capability_key = p_capability_key
        and stored.unit = p_unit
        and stored.corrects_metering_event_id is null
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
  else
    select stored.* into corrected
    from vortex_access.metering_events as stored
    where stored.tenant_id = p_tenant_id
      and stored.metering_event_id = p_corrects_metering_event_id;
    -- A correction targets an original event with the same attribution,
    -- allocation, capability and unit, so it never moves usage elsewhere.
    if not found
      or corrected.corrects_metering_event_id is not null
      or corrected.organization_id is distinct from p_organization_id
      or corrected.allocation_owner <> p_allocation_owner
      or corrected.capability_key <> p_capability_key
      or corrected.unit <> p_unit then
      raise exception using errcode = '22023', message = 'Metering correction target is unavailable';
    end if;
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id
        and stored.operation_id = p_operation_id
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
    if p_correction_direction = 'decrease' then
      select corrected.quantity + coalesce(pg_catalog.sum(
          case stored.correction_direction
            when 'increase' then stored.quantity
            else -stored.quantity
          end), 0)
      into corrected_remaining
      from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id;
      if p_quantity > corrected_remaining then
        raise exception using errcode = '22023',
          message = 'Metering correction exceeds the recorded quantity';
      end if;
    end if;
  end if;
  safe_event := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'meteringEventId', p_metering_event_id,
    'operationId', p_operation_id,
    'tenantId', p_tenant_id,
    'organizationId', p_organization_id,
    'allocationOwner', p_allocation_owner,
    'capabilityKey', p_capability_key,
    'quantity', p_quantity::float8,
    'unit', p_unit,
    'occurredAt', pg_catalog.to_char(p_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source', p_source,
    'sourceEventId', p_source_event_id,
    'dimensions', p_dimensions,
    'correlationId', p_correlation_id,
    'correctsMeteringEventId', p_corrects_metering_event_id,
    'correctionDirection', p_correction_direction,
    'acceptedAt', pg_catalog.to_char(accepted_at_value at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
  insert into vortex_access.metering_events (
    metering_event_id, operation_id, tenant_id, organization_id,
    allocation_owner, capability_key, quantity, unit, source, dimensions,
    occurred_at, source_event_id, correlation_id, corrects_metering_event_id,
    correction_direction, accepted_at, result
  ) values (
    p_metering_event_id, p_operation_id, p_tenant_id, p_organization_id,
    p_allocation_owner, p_capability_key, p_quantity, p_unit, p_source,
    p_dimensions, p_occurred_at, p_source_event_id, p_correlation_id, p_corrects_metering_event_id,
    p_correction_direction, accepted_at_value, safe_event
  );
  return query select pg_catalog.jsonb_build_object(
    'status', 'accepted', 'event', safe_event
  );
end
$function$;

comment on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, uuid, uuid, uuid, text
) is
  'Appends one immutable metering event for an operation or attempt, or replays it by event identity.';

revoke execute on function
  vortex_access.record_metering_event(
    uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
    uuid, uuid, uuid, uuid, text
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, uuid, uuid, uuid, text
) to vortex_request;

alter function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_metering_event_id uuid, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) owner to vortex_owner;

grant execute on function vortex_access.record_metering_event(p_tenant_id uuid, p_organization_id uuid, p_allocation_owner text, p_operation_id uuid, p_capability_key text, p_quantity numeric, p_unit text, p_source text, p_dimensions jsonb, p_occurred_at timestamp with time zone, p_source_event_id uuid, p_metering_event_id uuid, p_correlation_id uuid, p_corrects_metering_event_id uuid, p_correction_direction text) to postgres;

reset role;
