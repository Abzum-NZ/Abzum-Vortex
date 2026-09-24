-- #853: remove verified-unused database surfaces.
--
-- 1. The organisation invitation access-intent table, its immutability trigger
--    and the four intent-only functions had no caller: only the live no-intent
--    acceptance path remained. Wired as written, that intent surface would let
--    any member invite someone straight into an admin role, so it is removed
--    rather than left to drift. The live
--    `vortex_access.accept_organization_invitation` keeps its grants and is
--    replaced here with its complete body minus the obsolete intent check, so
--    it no longer reads the dropped table.
-- 2. `vortex_record.is_lifecycle_destination` still carried a URL/SQL clause
--    that can never match: the identifier pattern on the same predicate
--    already rejects every value containing a colon, a slash or a space. It is
--    replaced with its complete body minus that unreachable clause.
-- 3. pgTAP is installed by a normal migration in every environment, so its
--    functions carried the default PUBLIC execute privilege. That grant is
--    narrowed to the roles the committed database tests assert under.

-- 1. Complete replacement of the live destination predicate. Only the
-- unreachable clause is removed; the closed identifier pattern and the
-- function's attributes are carried over unchanged. Ownership, ACLs and the
-- comment survive CREATE OR REPLACE.
set local role vortex_record_owner;

create or replace function vortex_record.is_lifecycle_destination(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    pg_catalog.char_length(p_value) between 1 and 80
    and p_value ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$',
    false
  );
$function$;

reset role;

-- 2. Complete replacement of the live acceptance function. The intent-existence
-- check is removed; every other check, order and return shape is carried over
-- unchanged. The function keeps its owner and its vortex_runtime grant.
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

-- The previous comment pointed pending intent-bearing invitations at the
-- protected intent composition, which no longer exists.
comment on function vortex_access.accept_organization_invitation(
  text, uuid, text, text, uuid
) is
  'Runtime invitation acceptance under the organization access-version lock.';

-- 3. Drop the intent surface. The trigger goes first so the function it calls
-- can be dropped without CASCADE.
drop trigger if exists organization_invitation_access_intents_protect
  on vortex_access.organization_invitation_access_intents;

drop function if exists vortex_access.normalize_organization_invitation_access_intent(jsonb);
drop function if exists vortex_access.protect_organization_invitation_access_intent();
drop function if exists vortex_access.coordinate_organization_invitation_with_access_intent(
  text, text, timestamptz, jsonb
);
drop function if exists vortex_access.coordinate_organization_invitation_access_acceptance(
  text, uuid, text, text, uuid
);

drop table if exists vortex_access.organization_invitation_access_intents;

-- 4. PostgreSQL grants EXECUTE on every new function to PUBLIC by default.
-- pgTAP's helpers are security invoker, so the grant is narrowed to the roles
-- the committed database tests switch to before asserting; anon, service_role
-- and any future role lose it.
do $migration$
declare
  function_signature pg_catalog.regprocedure;
begin
  for function_signature in
    select proc.oid::pg_catalog.regprocedure
    from pg_catalog.pg_depend as dependency
    join pg_catalog.pg_extension as extension
      on extension.oid = dependency.refobjid
    join pg_catalog.pg_proc as proc
      on proc.oid = dependency.objid
    where extension.extname = 'pgtap'
      and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      and dependency.deptype = 'e'
      and proc.prokind = 'f'
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public', function_signature
    );
    execute pg_catalog.format(
      'grant execute on function %s to %s', function_signature,
      'vortex_request, vortex_runtime, vortex_record_adapter, '
        || 'vortex_module_owner, vortex_record_owner, authenticated'
    );
  end loop;
end
$migration$;
