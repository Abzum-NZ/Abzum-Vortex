set role vortex_owner;

-- An access change advances its own request context once, where the version advances, so a
-- flow's later statements in the same transaction validate against current access. The two
-- writers that advanced their context themselves no longer do. The delegation projection names
-- each holder (the person, or the Group) the way the assignment ledger names each assignee.

CREATE OR REPLACE FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) RETURNS TABLE(organization_id uuid, current_version bigint, changed_at timestamp with time zone, changed_by uuid, change_correlation_id uuid, change_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_activation_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  -- This marker detects a wrong request runner before UPDATE attempts a lock upgrade.
  -- It is not authority: callers still validate the current context and permission.
  if pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
    is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Access-version increment requires an exclusive access-change scope';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = greatest(version.changed_at, pg_catalog.clock_timestamp()),
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;

  -- The request that made this change continues at the version it produced, so its later
  -- statements (Activity, flow effects, receipts) validate against current access. Only this
  -- transaction's own context for this organisation moves, one step from the version it was
  -- admitted at, while the exclusive version lock is held until commit; identity, session,
  -- authentication, correlation and scope stay pinned, and rollback restores the context too.
  update vortex_platform.request_contexts as established
  set context = pg_catalog.jsonb_set(
    established.context, '{accessVersion}', pg_catalog.to_jsonb(version.current_version)
  )
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
    and established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id()
    and established.context ->> 'organizationId' = p_organization_id::text
    and established.context ->> 'accessVersion' = (version.current_version - 1)::text;

  -- A preview's copied live rows and fields were admitted under the previous access.
  -- Invalidate every builder's snapshot atomically with the version advance, while the
  -- access-change scope excludes preview requests. The next open seeds a new preview
  -- using current live access; retired physical storage is dropped in the background.
  perform vortex_access.invalidate_preview_installations_internal(p_organization_id);
end
$$;

create or replace function vortex_access.change_organization_role_authority_for_administration(
  p_changes jsonb
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  item jsonb;
  evidence jsonb;
  activity_id uuid;
  target_role_id uuid;
  operation_name text;
  changed record;
  changed_summary jsonb;
  seen_role_ids uuid[] := array[]::uuid[];
begin
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_changes) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  -- The caller holds the exclusive organisation Access lock for this entire request.
  -- Each iteration uses the existing protected coordinator, including its current authority,
  -- revision, template, recent-authentication, affected-assignment and stewardship checks.
  for item in select value from pg_catalog.jsonb_array_elements(p_changes) loop
    evidence := item -> 'evidence';
    operation_name := evidence #>> '{candidate,operation}';
    if pg_catalog.jsonb_typeof(item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(evidence) is distinct from 'object'
      or pg_catalog.jsonb_typeof(evidence -> 'candidate') is distinct from 'object'
      or operation_name is null
      or operation_name not in ('create_custom', 'create_custom_from_template',
        'accept_new_application_role', 'accept_application_role_revision')
      or (pg_catalog.jsonb_array_length(p_changes) > 1
        and operation_name not in ('accept_new_application_role', 'accept_application_role_revision'))
      or vortex_platform.is_non_nil_uuid(item ->> 'activityId') is not true
      or vortex_platform.is_non_nil_uuid(evidence #>> '{candidate,organizationId}') is not true
      or vortex_platform.is_non_nil_uuid(evidence #>> '{candidate,roleId}') is not true then
      raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
    end if;
    if (evidence #>> '{candidate,organizationId}')::uuid is distinct from context_organization_id then
      raise exception using errcode = '42501', message = 'Organization role-authority change is unavailable';
    end if;
    activity_id := (item ->> 'activityId')::uuid;
    target_role_id := (evidence #>> '{candidate,roleId}')::uuid;
    if target_role_id = any(seen_role_ids) then
      raise exception using errcode = '22023', message = 'Organization role-authority role is repeated';
    end if;
    seen_role_ids := pg_catalog.array_append(seen_role_ids, target_role_id);

    select result.* into strict changed
    from vortex_access.coordinate_private_organization_role_authority_change(evidence, activity_id) as result;
    changed_summary := vortex_access.project_organization_role_change_summary(context_organization_id, target_role_id);
    if changed_summary is null then
      raise exception using errcode = '40001', message = 'Changed organization role projection is unavailable';
    end if;
    return query select 'completed'::text, context_organization_id, changed_summary, changed.access_version;
  end loop;
exception
  when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'Organization role-authority change input is invalid';
end
$function$;

create or replace function vortex_access.change_application_installation_access(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_change text,
  p_prepared_templates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  current_registration vortex_access.permission_registrations%rowtype;
  registration_found boolean;
  coordinated_operation text;
  expected_revision bigint;
  changed record;
  assignment_to_revoke record;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change is null
    or p_change not in ('prepare', 'withdraw')
    or (p_change = 'prepare' and p_prepared_templates is null)
    or (p_change = 'withdraw' and p_prepared_templates is not null) then
    raise exception using errcode = '22023',
      message = 'Application installation access command is invalid';
  end if;

  -- Locks the organisation Access version and proves current installation
  -- authority. Every registration writer takes that lock first, so the
  -- registration read below cannot change before the coordinator rechecks it.
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;
  perform vortex_access.validated_human_request_context();

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  registration_found := found;

  if p_change = 'withdraw' then
    if not registration_found then
      raise exception using errcode = 'P0002',
        message = 'Application permission registration is unavailable';
    end if;
    if current_registration.state = 'withdrawn' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unchanged',
        'operation', 'withdraw',
        'organizationId', authority.organization_id,
        'applicationRootId', p_application_root_id,
        'registrationState', current_registration.state,
        'registrationRevision', current_registration.revision,
        'accessVersion', authority.access_version
      );
    end if;
    coordinated_operation := 'withdraw';
    expected_revision := current_registration.revision;
  elsif not registration_found then
    coordinated_operation := 'register';
    expected_revision := null;
  elsif current_registration.state = 'withdrawn' then
    coordinated_operation := 'reactivate';
    expected_revision := current_registration.revision;
  else
    coordinated_operation := 'update';
    expected_revision := current_registration.revision;
  end if;

  -- The coordinator validates the prepared candidate against the stored
  -- Application and Module releases and this organisation, applies continuity
  -- narrowing, never assigns a role, and asserts the permanent-steward
  -- invariant before it returns.
  select result.* into strict changed
  from vortex_access.coordinate_application_access_change(
    coordinated_operation,
    expected_revision,
    p_prepared_templates,
    authority.organization_id,
    p_application_root_id,
    authority.organization_account_id,
    authority.correlation_id
  ) as result;

  if changed.organization_id <> authority.organization_id
    or changed.application_root_id <> p_application_root_id
    or changed.correlation_id <> authority.correlation_id then
    raise exception using errcode = '55000',
      message = 'Application installation access result is inconsistent';
  end if;

  if changed.outcome = 'changed' then
    if p_change = 'withdraw' then
      -- Withdrawal ends every assignment of this application's roles. Keeping a
      -- live assignment would restore its access when a reinstall accepts the
      -- role again. Use the one assignment writer, retaining its revision and
      -- revocation history inside this same installation transaction.
      for assignment_to_revoke in
        select assignment.role_assignment_id, assignment.revision
        from vortex_access.organization_role_assignments as assignment
        join vortex_access.organization_roles as role
          on role.organization_id = assignment.organization_id
          and role.role_id = assignment.role_id
        where assignment.organization_id = authority.organization_id
          and role.application_root_id = p_application_root_id
          and role.role_kind = 'application'
          and assignment.state = 'live'
        order by assignment.role_assignment_id
        for update of assignment
      loop
        perform vortex_access.coordinate_organization_role_assignment_change(
          'revoke', authority.organization_id,
          assignment_to_revoke.role_assignment_id, assignment_to_revoke.revision,
          null, null, null, null, null, null, null, null,
          authority.organization_account_id, authority.correlation_id
        );
      end loop;
    end if;

    append_result := vortex_record.append_organization_activity_entry(
      authority.organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      authority.organization_account_id,
      coordinated_operation || '_application_access',
      array[p_application_root_id]::uuid[],
      array[]::uuid[],
      vortex_platform.channel(),
      authority.correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Application installation access Activity is stale';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', changed.outcome,
    'operation', changed.operation,
    'organizationId', changed.organization_id,
    'applicationRootId', changed.application_root_id,
    'registrationState', changed.registration_state,
    'registrationRevision', changed.registration_revision,
    'accessVersion', changed.access_version
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation access evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation access evidence is ambiguous';
end
$function$;

create or replace function vortex_access.list_organization_delegations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_expression text;
  sort_type text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'scope_kind', 'starts_at', 'expires_at', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Delegation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'scope_kind' then 'delegation.scope_kind'
    when 'starts_at' then 'delegation.starts_at'
    when 'expires_at' then 'delegation.expires_at'
    when 'state' then 'delegation.state'
    else 'delegation.delegation_authority_id' end;
  sort_type := case when p_sort_key in ('starts_at', 'expires_at')
    then 'timestamptz' else 'text' end;
  sort_expression := case
    when sort_type = 'text' then sort_column || ' collate "C"'
    else sort_column end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) not in ('string', 'null')
      )) then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_value := p_after -> 'sortKey' ->> 0;
      if sort_type = 'timestamptz' and after_value is not null then
        perform after_value::timestamptz;
      end if;
    exception when invalid_text_representation or invalid_datetime_format
      or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Delegation projection cursor is invalid';
    end;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and delegation.delegation_authority_id > $4'
        else ' and delegation.delegation_authority_id < $4' end;
    elsif p_sort_key = 'expires_at' then
      keyset_sql := case when after_value is null then
        case when p_direction = 'ascending' then
          ' and (delegation.expires_at is not null or
            (delegation.expires_at is null and delegation.delegation_authority_id > $4))'
        else ' and delegation.expires_at is null and delegation.delegation_authority_id < $4' end
      when p_direction = 'ascending' then
        ' and (delegation.expires_at, delegation.delegation_authority_id) > ($3::timestamptz, $4)'
      else ' and (delegation.expires_at is null or
        (delegation.expires_at, delegation.delegation_authority_id) < ($3::timestamptz, $4))' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s, delegation.delegation_authority_id) %s ($3::%s, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end,
        sort_type);
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('delegation.delegation_authority_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    when p_sort_key = 'expires_at' then pg_catalog.format(
      'delegation.expires_at %s nulls %s, delegation.delegation_authority_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'first' else 'last' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s %s, delegation.delegation_authority_id %s',
      sort_expression, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "holder_kind": {"sql": "delegation.holder_kind::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "delegation.organization_account_id::text", "database": "text", "filter": true},
      "group_id": {"sql": "delegation.group_id::text", "database": "text", "filter": true},
      "scope_kind": {"sql": "delegation.scope_kind::text", "database": "text", "filter": true},
      "state": {"sql": "delegation.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when delegation.state = 'revoked' then 'revoked' when delegation.starts_at > $5 then 'scheduled' when delegation.expires_at is not null and delegation.expires_at <= $5 then 'expired' else 'active' end)", "database": "text", "filter": true}
    }$declared$::jsonb,
    7
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := $scan$
    select delegation.organization_id, delegation.delegation_authority_id,
      delegation.revision,
      pg_catalog.jsonb_build_object(
        'holder_kind', delegation.holder_kind,
        'holder_display_name', coalesce(holder_account.display_name, holder_group.label),
        'organization_account_id', delegation.organization_account_id,
        'group_id', delegation.group_id,
        'scope_kind', delegation.scope_kind,
        'starts_at', delegation.starts_at,
        'expires_at', delegation.expires_at,
        'state', delegation.state,
        'temporal_state', case
          when delegation.state = 'revoked' then 'revoked'
          when delegation.starts_at > $5 then 'scheduled'
          when delegation.expires_at is not null
            and delegation.expires_at <= $5 then 'expired'
          else 'active' end)
    from vortex_access.organization_delegation_authorities as delegation
    left join vortex_identity.organization_accounts as holder_account
      on delegation.holder_kind = 'organization_account'
      and holder_account.organization_id = delegation.organization_id
      and holder_account.organization_account_id = delegation.organization_account_id
    left join vortex_access.organization_groups as holder_group
      on delegation.holder_kind = 'group'
      and holder_group.organization_id = delegation.organization_id
      and holder_group.group_id = delegation.group_id
    where delegation.organization_id = $1
      and ($2 is null or delegation.delegation_authority_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, checked_at, p_limit, predicate_plan -> 'parameters';
end
$function$;

reset role;
