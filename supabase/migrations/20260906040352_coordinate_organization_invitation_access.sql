create table vortex_access.organization_invitation_access_intents (
  invitation_id uuid not null,
  organization_id uuid not null,
  membership_intents jsonb not null,
  role_assignment_intents jsonb not null,
  intended_by_organization_account_id uuid not null,
  intended_at timestamptz not null,
  intent_correlation_id uuid not null,
  constraint organization_invitation_access_intents_pk primary key (invitation_id),
  constraint organization_invitation_access_intents_ids_non_nil check (
    invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and intended_by_organization_account_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
    and intent_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitation_access_intents_time_finite check (
    intended_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint organization_invitation_access_intents_invitation_fk foreign key (
    organization_id, invitation_id
  ) references vortex_identity.organization_invitations (
    organization_id, invitation_id
  ),
  constraint organization_invitation_access_intents_intender_fk foreign key (
    organization_id, intended_by_organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  )
);

alter table vortex_access.organization_invitation_access_intents enable row level security;
alter table vortex_access.organization_invitation_access_intents force row level security;

create function vortex_access.normalize_organization_invitation_access_intent(
  p_candidate jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  item record;
  membership_id uuid;
  group_id uuid;
  role_assignment_id uuid;
  role_id uuid;
  starts_at timestamptz;
  expires_at timestamptz;
  role_revision_numeric numeric;
  expected_role_revision bigint;
  previous_identity text;
  seen_group_ids uuid[] := array[]::uuid[];
  normalized_memberships jsonb := '[]'::jsonb;
  normalized_assignments jsonb := '[]'::jsonb;
begin
  if p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object'
    or not p_candidate ?& array['membershipIntents', 'roleAssignmentIntents']
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_candidate)) <> 2
    or pg_catalog.jsonb_typeof(p_candidate -> 'membershipIntents') <> 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'roleAssignmentIntents') <> 'array'
    or pg_catalog.jsonb_array_length(p_candidate -> 'membershipIntents')
      + pg_catalog.jsonb_array_length(p_candidate -> 'roleAssignmentIntents') = 0 then
    raise exception using errcode = '22023',
      message = 'Organization invitation access intent is invalid';
  end if;

  previous_identity := null;
  for item in
    select candidate.value, candidate.ordinality
    from pg_catalog.jsonb_array_elements(
      p_candidate -> 'membershipIntents'
    ) with ordinality as candidate(value, ordinality)
    order by candidate.ordinality
  loop
    if pg_catalog.jsonb_typeof(item.value) <> 'object'
      or not item.value ?& array['membershipId', 'groupId', 'startsAt']
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(item.value))
        <> (case when item.value ? 'expiresAt' then 4 else 3 end)
      or pg_catalog.jsonb_typeof(item.value -> 'membershipId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'groupId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'startsAt') <> 'string'
      or (item.value ? 'expiresAt'
        and pg_catalog.jsonb_typeof(item.value -> 'expiresAt') <> 'string') then
      raise exception using errcode = '22023',
        message = 'Organization invitation membership intent is invalid';
    end if;

    membership_id := (item.value ->> 'membershipId')::uuid;
    group_id := (item.value ->> 'groupId')::uuid;
    starts_at := (item.value ->> 'startsAt')::timestamptz;
    expires_at := case when item.value ? 'expiresAt'
      then (item.value ->> 'expiresAt')::timestamptz else null end;

    if membership_id = '00000000-0000-0000-0000-000000000000'::uuid
      or group_id = '00000000-0000-0000-0000-000000000000'::uuid
      or starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (expires_at is not null and expires_at <= starts_at)
      or group_id = any(seen_group_ids)
      or (previous_identity is not null and previous_identity >= membership_id::text) then
      raise exception using errcode = '22023',
        message = 'Organization invitation membership intent is invalid';
    end if;

    previous_identity := membership_id::text;
    seen_group_ids := pg_catalog.array_append(seen_group_ids, group_id);
    normalized_memberships := normalized_memberships || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'membershipId', membership_id,
        'groupId', group_id,
        'startsAt', starts_at,
        'expiresAt', expires_at
      ))
    );
  end loop;

  previous_identity := null;
  for item in
    select candidate.value, candidate.ordinality
    from pg_catalog.jsonb_array_elements(
      p_candidate -> 'roleAssignmentIntents'
    ) with ordinality as candidate(value, ordinality)
    order by candidate.ordinality
  loop
    if pg_catalog.jsonb_typeof(item.value) <> 'object'
      or not item.value ?& array[
        'roleAssignmentId', 'roleId', 'expectedRoleRevision',
        'assignmentKind', 'startsAt'
      ]
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(item.value))
        <> (case when item.value ? 'expiresAt' then 6 else 5 end)
      or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'expectedRoleRevision') <> 'number'
      or pg_catalog.jsonb_typeof(item.value -> 'assignmentKind') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'startsAt') <> 'string'
      or (item.value ? 'expiresAt'
        and pg_catalog.jsonb_typeof(item.value -> 'expiresAt') <> 'string') then
      raise exception using errcode = '22023',
        message = 'Organization invitation role-assignment intent is invalid';
    end if;

    role_assignment_id := (item.value ->> 'roleAssignmentId')::uuid;
    role_id := (item.value ->> 'roleId')::uuid;
    role_revision_numeric := (item.value ->> 'expectedRoleRevision')::numeric;
    starts_at := (item.value ->> 'startsAt')::timestamptz;
    expires_at := case when item.value ? 'expiresAt'
      then (item.value ->> 'expiresAt')::timestamptz else null end;

    if role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_revision_numeric <> pg_catalog.trunc(role_revision_numeric)
      or role_revision_numeric not between 1 and 9007199254740991
      or item.value ->> 'assignmentKind' not in ('standing', 'eligible')
      or starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (expires_at is not null and expires_at <= starts_at)
      or (previous_identity is not null
        and previous_identity >= role_assignment_id::text) then
      raise exception using errcode = '22023',
        message = 'Organization invitation role-assignment intent is invalid';
    end if;

    expected_role_revision := role_revision_numeric::bigint;
    previous_identity := role_assignment_id::text;
    normalized_assignments := normalized_assignments || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'roleAssignmentId', role_assignment_id,
        'roleId', role_id,
        'expectedRoleRevision', expected_role_revision,
        'assignmentKind', item.value ->> 'assignmentKind',
        'startsAt', starts_at,
        'expiresAt', expires_at
      ))
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'membershipIntents', normalized_memberships,
    'roleAssignmentIntents', normalized_assignments
  );
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization invitation access intent is invalid';
end
$function$;

create or replace function vortex_access.accept_organization_invitation(
  p_token_fingerprint text,
  p_identity_id uuid,
  p_verified_email text,
  p_display_name text,
  p_correlation_id uuid
)
returns table (
  outcome text,
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
begin
  if p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.organization_id into target_organization_id
  from vortex_identity.organization_invitations as candidate
  where candidate.token_fingerprint = p_token_fingerprint
    and candidate.invited_email = p_verified_email;

  if not found then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

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
    if exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = target_organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select candidate.* into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.organization_id = target_organization_id
    and candidate.token_fingerprint = p_token_fingerprint
  for update;

  if not found
    or invitation.invited_email <> p_verified_email
    or invitation.revoked_at is not null
    or (
      invitation.accepted_at is null
      and exists (
        select 1
        from vortex_access.organization_invitation_access_intents as intent
        where intent.organization_id = invitation.organization_id
          and intent.invitation_id = invitation.invitation_id
      )
    )
    or (
      invitation.accepted_at is null
      and invitation.expires_at <= pg_catalog.clock_timestamp()
    ) then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation_with_transition(
    p_token_fingerprint,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome = 'accepted' and accepted.access_transition <> 'unchanged' then
    select incremented.current_version into resulting_version
    from vortex_access.increment_organization_access_version(
      accepted.organization_id,
      accepted.organization_account_id,
      p_correlation_id,
      case accepted.access_transition
        when 'activated' then 'organization_account_activated'
        when 'reactivated' then 'organization_account_reactivated'
      end
    ) as incremented;
  elsif accepted.outcome in ('accepted', 'already_accepted') then
    select version.current_version into resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = accepted.organization_id;

    if not found then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id,
    accepted.organization_id, accepted.identity_id, accepted.display_name,
    accepted.state, accepted.language, accepted.time_zone,
    accepted.invitation_id, accepted.activated_at, accepted.suspended_at,
    accepted.closed_at, accepted.changed_at, accepted.state_changed_at,
    accepted.state_changed_by, accepted.state_change_correlation_id,
    accepted.revision, resulting_version;
end
$function$;

create or replace function vortex_access.protect_organization_invitation_access_intent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  invitation vortex_identity.organization_invitations%rowtype;
  normalized jsonb;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '23514',
      message = 'Organization invitation access intents are immutable';
  end if;

  normalized := vortex_access.normalize_organization_invitation_access_intent(
    pg_catalog.jsonb_build_object(
      'membershipIntents', new.membership_intents,
      'roleAssignmentIntents', new.role_assignment_intents
    )
  );

  select stored.* into invitation
  from vortex_identity.organization_invitations as stored
  where stored.organization_id = new.organization_id
    and stored.invitation_id = new.invitation_id;

  if not found
    or invitation.accepted_at is not null
    or invitation.revoked_at is not null
    or invitation.invited_by_organization_account_id
      <> new.intended_by_organization_account_id
    or invitation.created_at <> new.intended_at
    or normalized -> 'membershipIntents' <> new.membership_intents
    or normalized -> 'roleAssignmentIntents' <> new.role_assignment_intents then
    raise exception using errcode = '23514',
      message = 'Organization invitation access intent linkage is invalid';
  end if;

  return new;
end
$function$;

create or replace function vortex_access.coordinate_organization_invitation_with_access_intent(
  p_invited_email text,
  p_token_fingerprint text,
  p_expires_at timestamptz,
  p_access_intent jsonb
)
returns table (
  invitation jsonb,
  access_intent jsonb
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  checked jsonb;
  normalized jsonb;
  created record;
begin
  normalized := vortex_access.normalize_organization_invitation_access_intent(
    p_access_intent
  );
  checked := vortex_identity.validated_human_account_context();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (checked ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization invitation access-intent scope is unavailable';
  end if;

  if p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '22023',
      message = 'Invitation input is invalid';
  end if;

  select * into created
  from vortex_identity.create_organization_invitation(
    p_invited_email,
    p_token_fingerprint,
    p_expires_at
  );

  insert into vortex_access.organization_invitation_access_intents (
    invitation_id, organization_id, membership_intents,
    role_assignment_intents, intended_by_organization_account_id,
    intended_at, intent_correlation_id
  ) values (
    created.invitation_id, created.organization_id,
    normalized -> 'membershipIntents',
    normalized -> 'roleAssignmentIntents',
    created.invited_by, created.created_at,
    (checked ->> 'correlationId')::uuid
  );

  return query
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'invitationId', created.invitation_id,
      'organizationId', created.organization_id,
      'invitedEmail', created.invited_email,
      'invitedBy', created.invited_by,
      'createdAt', created.created_at,
      'invitedAt', created.invited_at,
      'expiresAt', created.expires_at,
      'revokedAt', created.revoked_at,
      'revokedBy', created.revoked_by,
      'acceptedAt', created.accepted_at,
      'acceptedOrganizationAccountId', created.accepted_organization_account_id,
      'changedAt', created.changed_at,
      'revision', created.revision
    )),
    pg_catalog.jsonb_build_object(
      'organizationId', created.organization_id,
      'invitationId', created.invitation_id,
      'membershipIntents', normalized -> 'membershipIntents',
      'roleAssignmentIntents', normalized -> 'roleAssignmentIntents',
      'intendedByOrganizationAccountId', created.invited_by,
      'intendedAt', created.created_at,
      'intentCorrelationId', (checked ->> 'correlationId')::uuid
    );
end
$function$;

create or replace function vortex_access.coordinate_organization_invitation_access_acceptance(
  p_token_fingerprint text,
  p_identity_id uuid,
  p_verified_email text,
  p_display_name text,
  p_correlation_id uuid
)
returns table (
  outcome text,
  organization_account jsonb,
  invitation_id uuid,
  membership_ids uuid[],
  role_assignment_ids uuid[],
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  locked_access_version bigint;
  invitation vortex_identity.organization_invitations%rowtype;
  stored_intent vortex_access.organization_invitation_access_intents%rowtype;
  planned record;
  role_fact record;
  accepted record;
  checked_at timestamptz;
  resulting_version bigint;
  resulting_membership_ids uuid[];
  resulting_assignment_ids uuid[];
begin
  if p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.organization_id into target_organization_id
  from vortex_identity.organization_invitations as candidate
  join vortex_access.organization_invitation_access_intents as candidate_intent
    on candidate_intent.organization_id = candidate.organization_id
    and candidate_intent.invitation_id = candidate.invitation_id
  where candidate.token_fingerprint = p_token_fingerprint
    and candidate.invited_email = p_verified_email;

  if not found then
    return query select 'unavailable'::text, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  select version.current_version into locked_access_version
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
    return query select 'unavailable'::text, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  select candidate.* into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.organization_id = target_organization_id
    and candidate.token_fingerprint = p_token_fingerprint
  for update;

  if not found
    or invitation.invited_email <> p_verified_email
    or invitation.revoked_at is not null then
    return query select 'unavailable'::text, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  select candidate_intent.* into stored_intent
  from vortex_access.organization_invitation_access_intents as candidate_intent
  where candidate_intent.organization_id = invitation.organization_id
    and candidate_intent.invitation_id = invitation.invitation_id;
  if not found then
    return query select 'unavailable'::text, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  select coalesce(
      pg_catalog.array_agg((entry.value ->> 'membershipId')::uuid
        order by entry.value ->> 'membershipId'),
      array[]::uuid[]
    ) into resulting_membership_ids
  from pg_catalog.jsonb_array_elements(stored_intent.membership_intents) as entry(value);

  select coalesce(
      pg_catalog.array_agg((entry.value ->> 'roleAssignmentId')::uuid
        order by entry.value ->> 'roleAssignmentId'),
      array[]::uuid[]
    ) into resulting_assignment_ids
  from pg_catalog.jsonb_array_elements(stored_intent.role_assignment_intents) as entry(value);

  if invitation.accepted_at is not null then
    select * into accepted
    from vortex_identity.accept_organization_invitation_with_transition(
      p_token_fingerprint,
      p_identity_id,
      p_verified_email,
      p_display_name,
      p_correlation_id
    );

    if accepted.outcome not in ('accepted', 'already_accepted') then
      return query select accepted.outcome, null::jsonb, null::uuid,
        null::uuid[], null::uuid[], null::bigint, null::uuid;
      return;
    end if;

    return query
    select accepted.outcome,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'organizationAccountId', accepted.organization_account_id,
        'organizationId', accepted.organization_id,
        'identityId', accepted.identity_id,
        'displayName', accepted.display_name,
        'state', accepted.state,
        'language', accepted.language,
        'timeZone', accepted.time_zone,
        'invitationId', accepted.invitation_id,
        'activatedAt', accepted.activated_at,
        'suspendedAt', accepted.suspended_at,
        'closedAt', accepted.closed_at,
        'changedAt', accepted.changed_at,
        'stateChangedAt', accepted.state_changed_at,
        'stateChangedBy', accepted.state_changed_by,
        'stateChangeCorrelationId', accepted.state_change_correlation_id,
        'revision', accepted.revision
      )), invitation.invitation_id, resulting_membership_ids,
      resulting_assignment_ids, locked_access_version, p_correlation_id;
    return;
  end if;

  if exists (
    select 1
    from vortex_access.organization_group_memberships as membership
    join pg_catalog.jsonb_array_elements(stored_intent.membership_intents)
      as intended(value)
      on membership.membership_id = (intended.value ->> 'membershipId')::uuid
    where membership.organization_id = invitation.organization_id
  ) or exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join pg_catalog.jsonb_array_elements(stored_intent.role_assignment_intents)
      as intended(value)
      on assignment.role_assignment_id =
        (intended.value ->> 'roleAssignmentId')::uuid
    where assignment.organization_id = invitation.organization_id
  ) then
    raise exception using errcode = '40001',
      message = 'Organization invitation access intent identities are unavailable';
  end if;

  for planned in
    select entry.value
    from pg_catalog.jsonb_array_elements(stored_intent.membership_intents)
      as entry(value)
    order by entry.value ->> 'groupId', entry.value ->> 'membershipId'
  loop
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = invitation.organization_id
      and organization_group.group_id = (planned.value ->> 'groupId')::uuid
      and organization_group.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization invitation Group intent is stale or unavailable';
    end if;
  end loop;

  for planned in
    select entry.value
    from pg_catalog.jsonb_array_elements(stored_intent.role_assignment_intents)
      as entry(value)
    order by entry.value ->> 'roleId', entry.value ->> 'roleAssignmentId'
  loop
    select role.live_revision, revision.lifecycle, revision.assignment_policy
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = invitation.organization_id
      and role.role_id = (planned.value ->> 'roleId')::uuid
    for update of role;

    if not found
      or role_fact.live_revision <> (planned.value ->> 'expectedRoleRevision')::bigint
      or role_fact.lifecycle <> 'active'
      or not (
        (planned.value ->> 'assignmentKind' = 'standing'
          and role_fact.assignment_policy = 'standing')
        or (planned.value ->> 'assignmentKind' = 'eligible'
          and role_fact.assignment_policy = 'activation_required')
      ) then
      raise exception using errcode = '40001',
        message = 'Organization invitation role-assignment intent is stale or unavailable';
    end if;
  end loop;

  checked_at := pg_catalog.clock_timestamp();
  if invitation.expires_at <= checked_at then
    return query select 'unavailable'::text, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(stored_intent.membership_intents)
      as intended(value)
    where intended.value ? 'expiresAt'
      and (intended.value ->> 'expiresAt')::timestamptz <= checked_at
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(stored_intent.role_assignment_intents)
      as intended(value)
    where intended.value ? 'expiresAt'
      and (intended.value ->> 'expiresAt')::timestamptz <= checked_at
  ) then
    raise exception using errcode = '40001',
      message = 'Organization invitation access intent window is no longer current';
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation_with_transition(
    p_token_fingerprint,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome <> 'accepted' then
    return query select accepted.outcome, null::jsonb, null::uuid,
      null::uuid[], null::uuid[], null::bigint, null::uuid;
    return;
  end if;

  for planned in
    select entry.value
    from pg_catalog.jsonb_array_elements(stored_intent.membership_intents)
      as entry(value)
    order by entry.value ->> 'membershipId'
  loop
    insert into vortex_access.organization_group_memberships (
      organization_id, membership_id, group_id, organization_account_id,
      revision, starts_at, expires_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id,
      revoked_by, revoked_at, revocation_correlation_id
    ) values (
      invitation.organization_id, (planned.value ->> 'membershipId')::uuid,
      (planned.value ->> 'groupId')::uuid, accepted.organization_account_id,
      1, (planned.value ->> 'startsAt')::timestamptz,
      case when planned.value ? 'expiresAt'
        then (planned.value ->> 'expiresAt')::timestamptz else null end,
      'live', stored_intent.intended_by_organization_account_id, checked_at,
      p_correlation_id, stored_intent.intended_by_organization_account_id,
      checked_at, p_correlation_id, null, null, null
    );
  end loop;

  for planned in
    select entry.value
    from pg_catalog.jsonb_array_elements(stored_intent.role_assignment_intents)
      as entry(value)
    order by entry.value ->> 'roleAssignmentId'
  loop
    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, assignment_kind, revision, starts_at,
      expires_at, state, granted_by, granted_at, grant_correlation_id,
      changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      invitation.organization_id,
      (planned.value ->> 'roleAssignmentId')::uuid,
      (planned.value ->> 'roleId')::uuid, 'organization_account',
      accepted.organization_account_id, null,
      planned.value ->> 'assignmentKind', 1,
      (planned.value ->> 'startsAt')::timestamptz,
      case when planned.value ? 'expiresAt'
        then (planned.value ->> 'expiresAt')::timestamptz else null end,
      'live', stored_intent.intended_by_organization_account_id, checked_at,
      p_correlation_id, stored_intent.intended_by_organization_account_id,
      checked_at, p_correlation_id, null, null, null
    );
  end loop;

  select version.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    invitation.organization_id,
    stored_intent.intended_by_organization_account_id,
    p_correlation_id,
    'invitation_access_accepted'
  ) as version;

  return query
  select accepted.outcome,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationAccountId', accepted.organization_account_id,
      'organizationId', accepted.organization_id,
      'identityId', accepted.identity_id,
      'displayName', accepted.display_name,
      'state', accepted.state,
      'language', accepted.language,
      'timeZone', accepted.time_zone,
      'invitationId', accepted.invitation_id,
      'activatedAt', accepted.activated_at,
      'suspendedAt', accepted.suspended_at,
      'closedAt', accepted.closed_at,
      'changedAt', accepted.changed_at,
      'stateChangedAt', accepted.state_changed_at,
      'stateChangedBy', accepted.state_changed_by,
      'stateChangeCorrelationId', accepted.state_change_correlation_id,
      'revision', accepted.revision
    )), invitation.invitation_id, resulting_membership_ids,
    resulting_assignment_ids, resulting_version, p_correlation_id;
end
$function$;

revoke all on vortex_access.organization_invitation_access_intents
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.normalize_organization_invitation_access_intent(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.protect_organization_invitation_access_intent()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_invitation_with_access_intent(
    text, text, timestamptz, jsonb
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_invitation_access_acceptance(
    text, uuid, text, text, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) to vortex_runtime;

comment on table vortex_access.organization_invitation_access_intents is
  'One immutable same-organization access intent bound to an Identity invitation; accepted linkage is derived without an applied flag or copied secret.';
comment on function
  vortex_access.coordinate_organization_invitation_with_access_intent(
    text, text, timestamptz, jsonb
  ) is
  'Owner-only governance-first creation of an Identity invitation and one immutable canonical membership/direct-role intent.';
comment on function
  vortex_access.coordinate_organization_invitation_access_acceptance(
    text, uuid, text, text, uuid
  ) is
  'Owner-only governance-first acceptance of one intent-bearing invitation, its exact current access facts and one composite Access change.';
comment on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) is
  'Runtime-compatible no-intent invitation acceptance. Pending intent-bearing invitations require the protected intent composition.';

-- Keep Identity's established audit timestamps and replay semantics. Only the
-- first-use expiry decision observes the clock after the invitation row lock.
create or replace function vortex_identity.accept_organization_invitation(
  p_token_fingerprint text,
  p_identity_id uuid,
  p_verified_email text,
  p_display_name text,
  p_correlation_id uuid
)
returns table (
  outcome text,
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  invitation vortex_identity.organization_invitations%rowtype;
  account vortex_identity.organization_accounts%rowtype;
  projection_state text;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  new_account_id uuid;
  result_outcome text := 'accepted';
begin
  if p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.*
  into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.token_fingerprint = p_token_fingerprint
  for update;

  if not found
    or invitation.invited_email <> p_verified_email
    or invitation.revoked_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  if invitation.accepted_at is not null then
    select existing.* into account
    from vortex_identity.organization_accounts as existing
    where existing.organization_account_id = invitation.accepted_organization_account_id
      and existing.organization_id = invitation.organization_id
      and existing.identity_id = p_identity_id;

    if not found then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    select projection.state into projection_state
    from vortex_identity.identity_projections as projection
    where projection.identity_id = p_identity_id
    for update;

    if projection_state is distinct from 'active' then
      return query select 'identity_inactive'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    if account.state <> 'active' or not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = account.organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    result_outcome := 'already_accepted';
  else
    if invitation.expires_at <= pg_catalog.clock_timestamp() or not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = invitation.organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    insert into vortex_identity.identity_projections (
      identity_id, state, created_at, state_changed_at, state_changed_by,
      state_change_correlation_id, revision
    ) values (
      p_identity_id, 'active', operation_at, operation_at, p_identity_id,
      p_correlation_id, 1
    ) on conflict on constraint identity_projections_pk do nothing;

    select projection.state into projection_state
    from vortex_identity.identity_projections as projection
    where projection.identity_id = p_identity_id
    for update;

    if projection_state <> 'active' then
      return query select 'identity_inactive'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    select existing.* into account
    from vortex_identity.organization_accounts as existing
    where existing.organization_id = invitation.organization_id
      and existing.identity_id = p_identity_id
    for update;

    if found then
      if account.state <> 'active'
        and invitation.invited_at <= account.state_changed_at then
        return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
          null::text, null::text, null::text, null::text, null::uuid,
          null::timestamptz, null::timestamptz, null::timestamptz,
          null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
        return;
      end if;

      if account.state <> 'active' then
        update vortex_identity.organization_accounts as existing
        set state = 'active',
            display_name = coalesce(existing.display_name, p_display_name),
            originating_invitation_id = invitation.invitation_id,
            activated_at = existing.activated_at,
            changed_at = operation_at,
            state_changed_at = operation_at,
            state_changed_by = p_identity_id,
            state_change_correlation_id = p_correlation_id,
            revision = existing.revision + 1
        where existing.organization_account_id = account.organization_account_id
        returning existing.* into account;
      end if;
    else
      loop
        new_account_id := pg_catalog.gen_random_uuid();
        exit when new_account_id <>
          '00000000-0000-0000-0000-000000000000'::uuid;
      end loop;

      insert into vortex_identity.organization_accounts (
        organization_account_id, organization_id, identity_id, display_name,
        state, originating_invitation_id, activated_at, changed_at,
        state_changed_at, state_changed_by, state_change_correlation_id,
        revision
      ) values (
        new_account_id, invitation.organization_id, p_identity_id,
        p_display_name, 'active', invitation.invitation_id, operation_at,
        operation_at, operation_at, p_identity_id, p_correlation_id, 1
      ) returning * into account;
    end if;

    update vortex_identity.organization_invitations as accepted
    set accepted_at = operation_at,
        accepted_organization_account_id = account.organization_account_id,
        changed_at = operation_at,
        revision = accepted.revision + 1
    where accepted.invitation_id = invitation.invitation_id
      and accepted.accepted_at is null
      and accepted.revoked_at is null;
  end if;

  return query
  select result_outcome, account.organization_account_id,
    account.organization_id, account.identity_id, account.display_name,
    account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at,
    account.suspended_at, account.closed_at, account.changed_at,
    account.state_changed_at, account.state_changed_by,
    account.state_change_correlation_id, account.revision;
end
$function$;

create trigger organization_invitation_access_intents_protect
before insert or update or delete
on vortex_access.organization_invitation_access_intents
for each row execute function
  vortex_access.protect_organization_invitation_access_intent();

revoke all on vortex_access.organization_invitation_access_intents
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.normalize_organization_invitation_access_intent(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.protect_organization_invitation_access_intent()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_invitation_with_access_intent(
    text, text, timestamptz, jsonb
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_invitation_access_acceptance(
    text, uuid, text, text, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) to vortex_runtime;

comment on table vortex_access.organization_invitation_access_intents is
  'One immutable same-organization access intent bound to an Identity invitation; accepted linkage is derived without an applied flag or copied secret.';
comment on function
  vortex_access.coordinate_organization_invitation_with_access_intent(
    text, text, timestamptz, jsonb
  ) is
  'Owner-only governance-first creation of an Identity invitation and one immutable canonical membership/direct-role intent.';
comment on function
  vortex_access.coordinate_organization_invitation_access_acceptance(
    text, uuid, text, text, uuid
  ) is
  'Owner-only governance-first acceptance of one intent-bearing invitation, its exact current access facts and one composite Access change.';
comment on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) is
  'Runtime-compatible no-intent invitation acceptance. Pending intent-bearing invitations require the protected intent composition.';
