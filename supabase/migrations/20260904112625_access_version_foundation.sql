-- Access owns one live version per organisation. The Identity service continues
-- to own account state; the wrappers below are the only database operations
-- that couple account access changes to this counter.
create schema if not exists vortex_access authorization postgres;

revoke all on schema vortex_access
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_access
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_access
  revoke all on sequences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_access
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create table vortex_access.organization_access_versions (
  organization_id uuid not null,
  current_version bigint not null,
  changed_at timestamptz not null,
  changed_by uuid not null,
  change_correlation_id uuid not null,
  change_reason text not null,
  constraint organization_access_versions_pk primary key (organization_id),
  constraint organization_access_versions_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_access_versions_current_version_range check (
    current_version between 1 and 9007199254740991
  ),
  constraint organization_access_versions_changed_by_non_nil check (
    changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_access_versions_correlation_non_nil check (
    change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_access_versions_reason_valid check (
    change_reason in (
      'organization_initialized',
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'team_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    )
  ),
  constraint organization_access_versions_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

alter table vortex_access.organization_access_versions enable row level security;
alter table vortex_access.organization_access_versions force row level security;

create function vortex_access.protect_organization_access_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'Access-version organisation is permanent';
  end if;

  if new.current_version <> old.current_version + 1
    or new.changed_at < old.changed_at
    or new.change_reason is null then
    raise exception using errcode = '23514', message = 'Access-version updates require one complete increment';
  end if;

  return new;
end
$function$;

create trigger organization_access_versions_protect_update
before update on vortex_access.organization_access_versions
for each row execute function vortex_access.protect_organization_access_version();

insert into vortex_access.organization_access_versions (
  organization_id,
  current_version,
  changed_at,
  changed_by,
  change_correlation_id,
  change_reason
)
select
  organization.organization_id,
  1,
  pg_catalog.statement_timestamp(),
  organization.created_by,
  pg_catalog.gen_random_uuid(),
  'organization_initialized'
from vortex_identity.organizations as organization
on conflict on constraint organization_access_versions_pk do nothing;

create function vortex_access.initialize_organization_access_version(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  current_version bigint,
  changed_at timestamptz,
  changed_by uuid,
  change_correlation_id uuid,
  change_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Access-version initialization input is invalid';
  end if;

  insert into vortex_access.organization_access_versions as version (
    organization_id, current_version, changed_at, changed_by,
    change_correlation_id, change_reason
  ) values (
    p_organization_id, 1, operation_at, p_changed_by,
    p_correlation_id, 'organization_initialized'
  ) on conflict on constraint organization_access_versions_pk do nothing;

  return query
  select version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$function$;

create function vortex_access.current_organization_access_version(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (
  organization_id uuid,
  current_version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_tenant_id is null
    or p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Access-version scope is invalid';
  end if;

  return query
  select version.organization_id, version.current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
    and organization.state = 'active'
    and tenant.state = 'active';

  if not found then
    raise exception using errcode = '42501', message = 'Access-version scope is unavailable';
  end if;
end
$function$;

create function vortex_access.increment_organization_access_version(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_change_reason text
)
returns table (
  organization_id uuid,
  current_version bigint,
  changed_at timestamptz,
  changed_by uuid,
  change_correlation_id uuid,
  change_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
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
      'team_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = operation_at,
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
end
$function$;

-- Identity owns classification of its account transition. Access consumes this
-- owner-only contract and never reads Identity relations directly.
create function vortex_identity.accept_organization_invitation_with_transition(
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
  access_transition text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  candidate_organization_id uuid;
  prior_account_state text;
  classified_transition text := 'unchanged';
  accepted record;
begin
  select invitation.organization_id into candidate_organization_id
  from vortex_identity.organization_invitations as invitation
  where invitation.token_fingerprint = p_token_fingerprint
    and invitation.invited_email = p_verified_email
  for update;

  if found then
    select account.state into prior_account_state
    from vortex_identity.organization_accounts as account
    where account.organization_id = candidate_organization_id
      and account.identity_id = p_identity_id
    for update;

    if not found then
      classified_transition := 'activated';
    elsif prior_account_state <> 'active' then
      classified_transition := 'reactivated';
    end if;
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_token_fingerprint,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome <> 'accepted' then
    classified_transition := 'unchanged';
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id, accepted.organization_id,
    accepted.identity_id, accepted.display_name, accepted.state, accepted.language,
    accepted.time_zone, accepted.invitation_id, accepted.activated_at,
    accepted.suspended_at, accepted.closed_at, accepted.changed_at,
    accepted.state_changed_at, accepted.state_changed_by,
    accepted.state_change_correlation_id, accepted.revision, classified_transition;
end
$function$;

create function vortex_access.accept_organization_invitation(
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
  accepted record;
  resulting_version bigint;
begin
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
      raise exception using errcode = '40001', message = 'Access version is unavailable';
    end if;
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id, accepted.organization_id,
    accepted.identity_id, accepted.display_name, accepted.state, accepted.language,
    accepted.time_zone, accepted.invitation_id, accepted.activated_at,
    accepted.suspended_at, accepted.closed_at, accepted.changed_at,
    accepted.state_changed_at, accepted.state_changed_by,
    accepted.state_change_correlation_id, accepted.revision, resulting_version;
end
$function$;

create function vortex_access.change_organization_account_state(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_state text
)
returns table (
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
  changed record;
  checked jsonb;
  resulting_version bigint;
begin
  checked := vortex_identity.validated_human_account_context();

  select * into changed
  from vortex_identity.change_organization_account_state(
    p_organization_account_id,
    p_expected_revision,
    p_state
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    changed.organization_id,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'correlationId')::uuid,
    case changed.state
      when 'active' then 'organization_account_reactivated'
      when 'suspended' then 'organization_account_suspended'
      when 'closed' then 'organization_account_closed'
    end
  ) as incremented;

  return query
  select changed.organization_account_id, changed.organization_id, changed.identity_id,
    changed.display_name, changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, resulting_version;
end
$function$;

revoke all on all tables in schema vortex_access
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on all sequences in schema vortex_access
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on all functions in schema vortex_access
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- Runtime invitation acceptance must not bypass the Access-owned transaction.
revoke execute on function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid)
  from vortex_runtime;
revoke execute on function vortex_identity.accept_organization_invitation_with_transition(
  text, uuid, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant usage on schema vortex_access to vortex_runtime;
grant execute on function vortex_access.current_organization_access_version(uuid, uuid)
  to vortex_runtime;
grant execute on function vortex_access.accept_organization_invitation(text, uuid, text, text, uuid)
  to vortex_runtime;

comment on schema vortex_access is
  'Private live access state owned by the Access service.';
comment on table vortex_access.organization_access_versions is
  'One current positive access version and last-change evidence per organisation.';
comment on function vortex_access.current_organization_access_version(uuid, uuid) is
  'Returns only the current version for one exact active tenant and organisation.';
comment on function vortex_access.accept_organization_invitation(text, uuid, text, text, uuid) is
  'Atomically composes Identity invitation acceptance with Access-version invalidation.';
comment on function vortex_identity.accept_organization_invitation_with_transition(
  text, uuid, text, text, uuid
) is 'Owner-only Identity invitation transition with explicit Access change classification.';
comment on function vortex_access.change_organization_account_state(uuid, bigint, text) is
  'Owner-only account lifecycle and Access-version composition reserved for permission-checked administration.';
