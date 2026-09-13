-- Identity owns the safe organisation-local account and invitation projections.
-- These helpers accept an explicit scope only from the Access-owned wrappers
-- below and remain unavailable to every application/request role.
create function vortex_identity.list_organization_accounts_for_administration_internal(
  p_organization_id uuid,
  p_after_organization_account_id uuid,
  p_page_size integer
)
returns table (
  accounts jsonb,
  next_after_organization_account_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_items jsonb;
  page_account_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration page input is invalid';
  end if;

  with candidates as (
    select account.organization_account_id, account.display_name,
      account.state, account.language, account.time_zone, account.revision,
      pg_catalog.row_number() over (
        order by account.organization_account_id
      ) as ordinal
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and (
        p_after_organization_account_id is null
        or account.organization_account_id > p_after_organization_account_id
      )
    order by account.organization_account_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'organizationAccountId', candidate.organization_account_id,
          'displayName', candidate.display_name,
          'state', candidate.state,
          'language', candidate.language,
          'timeZone', candidate.time_zone,
          'revision', candidate.revision
        )) order by candidate.organization_account_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.organization_account_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into account_items, page_account_ids, candidate_count
  from candidates as candidate;

  return query select account_items,
    case when candidate_count > p_page_size
      then page_account_ids[p_page_size] else null end;
end
$function$;

create function vortex_identity.read_organization_account_for_administration_internal(
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  account_summary jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationAccountId', account.organization_account_id,
    'displayName', account.display_name,
    'state', account.state,
    'language', account.language,
    'timeZone', account.time_zone,
    'revision', account.revision
  ))
  into account_value
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id;

  return query select
    case when account_value is null then 'unavailable' else 'available' end,
    account_value;
end
$function$;

create function vortex_identity.list_organization_invitations_for_administration_internal(
  p_organization_id uuid,
  p_after_invitation_id uuid,
  p_page_size integer
)
returns table (
  invitations jsonb,
  next_after_invitation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_items jsonb;
  page_invitation_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration page input is invalid';
  end if;

  with candidates as (
    select invitation.invitation_id, invitation.organization_id,
      invitation.invited_email, invitation.invited_by_organization_account_id,
      invitation.created_at, invitation.invited_at, invitation.expires_at,
      invitation.revoked_at, invitation.revoked_by_organization_account_id,
      invitation.accepted_at, invitation.accepted_organization_account_id,
      invitation.changed_at, invitation.revision,
      pg_catalog.row_number() over (order by invitation.invitation_id) as ordinal
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = p_organization_id
      and (
        p_after_invitation_id is null
        or invitation.invitation_id > p_after_invitation_id
      )
    order by invitation.invitation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'invitationId', candidate.invitation_id,
          'organizationId', candidate.organization_id,
          'invitedEmail', candidate.invited_email,
          'invitedBy', candidate.invited_by_organization_account_id,
          'createdAt', candidate.created_at,
          'invitedAt', candidate.invited_at,
          'expiresAt', candidate.expires_at,
          'revokedAt', candidate.revoked_at,
          'revokedBy', candidate.revoked_by_organization_account_id,
          'acceptedAt', candidate.accepted_at,
          'acceptedOrganizationAccountId', candidate.accepted_organization_account_id,
          'changedAt', candidate.changed_at,
          'revision', candidate.revision
        )) order by candidate.invitation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.invitation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into invitation_items, page_invitation_ids, candidate_count
  from candidates as candidate;

  return query select invitation_items,
    case when candidate_count > p_page_size
      then page_invitation_ids[p_page_size] else null end;
end
$function$;

create function vortex_identity.read_organization_invitation_for_administration_internal(
  p_organization_id uuid,
  p_invitation_id uuid
)
returns table (
  outcome text,
  invitation jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_invitation_id is null
    or p_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'invitationId', invitation.invitation_id,
    'organizationId', invitation.organization_id,
    'invitedEmail', invitation.invited_email,
    'invitedBy', invitation.invited_by_organization_account_id,
    'createdAt', invitation.created_at,
    'invitedAt', invitation.invited_at,
    'expiresAt', invitation.expires_at,
    'revokedAt', invitation.revoked_at,
    'revokedBy', invitation.revoked_by_organization_account_id,
    'acceptedAt', invitation.accepted_at,
    'acceptedOrganizationAccountId', invitation.accepted_organization_account_id,
    'changedAt', invitation.changed_at,
    'revision', invitation.revision
  ))
  into invitation_value
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and invitation.invitation_id = p_invitation_id;

  return query select
    case when invitation_value is null then 'unavailable' else 'available' end,
    invitation_value;
end
$function$;

-- Each Access helper has one immutable declaration. The request cannot choose
-- a permission, target, clock, authority mode, or projection.
create function vortex_access.organization_accounts_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.accounts.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '02c772e5-2921-4300-ad90-4f5772a7fa46'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.accounts.read'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization account administration is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.organization_invitations_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.invitations.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '9300e501-6d56-41b1-b203-3361dbace9bc'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.invitations.read'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization invitation administration is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.organization_runtime_settings_administration_read_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.runtime_settings.read'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings administration read is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.list_organization_accounts_for_administration(
  p_after_organization_account_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  accounts jsonb,
  next_after_organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.list_organization_accounts_for_administration_internal(
    scope.organization_id, p_after_organization_account_id, p_page_size
  ) as result;
  return query select scope.organization_id, projected.accounts,
    projected.next_after_organization_account_id, scope.access_version;
end
$function$;

create function vortex_access.read_organization_account_for_administration(
  p_organization_account_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  account_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.read_organization_account_for_administration_internal(
    scope.organization_id, p_organization_account_id
  ) as result;
  return query select scope.organization_id, projected.outcome,
    projected.account_summary, scope.access_version;
end
$function$;

create function vortex_access.list_organization_invitations_for_administration(
  p_after_invitation_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  invitations jsonb,
  next_after_invitation_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.list_organization_invitations_for_administration_internal(
    scope.organization_id, p_after_invitation_id, p_page_size
  ) as result;
  return query select scope.organization_id, projected.invitations,
    projected.next_after_invitation_id, scope.access_version;
end
$function$;

create function vortex_access.read_organization_invitation_for_administration(
  p_invitation_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  invitation jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_scope() as authorized;
  select result.* into strict projected
  from vortex_identity.read_organization_invitation_for_administration_internal(
    scope.organization_id, p_invitation_id
  ) as result;
  return query select scope.organization_id, projected.outcome,
    projected.invitation, scope.access_version;
end
$function$;

create function vortex_access.read_organization_runtime_settings_for_administration()
returns table (
  organization_id uuid,
  outcome text,
  settings jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  select result.* into projected
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope.organization_id
  ) as result;

  return query select scope.organization_id,
    case when projected.organization_id is null then 'unavailable' else 'available' end,
    case when projected.organization_id is null then null else
      pg_catalog.jsonb_build_object(
        'organizationId', projected.organization_id,
        'language', projected.language,
        'timeZone', projected.time_zone,
        'currency', projected.currency,
        'dateFormat', projected.date_format,
        'numberFormat', projected.number_format,
        'revision', projected.revision
      )
    end,
    scope.access_version;
end
$function$;

revoke execute on function vortex_identity.list_organization_accounts_for_administration_internal(
  uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_identity.read_organization_account_for_administration_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_identity.list_organization_invitations_for_administration_internal(
  uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_identity.read_organization_invitation_for_administration_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

revoke execute on function vortex_access.organization_accounts_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.organization_invitations_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.organization_runtime_settings_administration_read_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

revoke execute on function vortex_access.list_organization_accounts_for_administration(
  uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.read_organization_account_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.list_organization_invitations_for_administration(
  uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.read_organization_invitation_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_access.read_organization_runtime_settings_for_administration()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

grant execute on function vortex_access.list_organization_accounts_for_administration(
  uuid, integer
) to vortex_request;
grant execute on function vortex_access.read_organization_account_for_administration(uuid)
to vortex_request;
grant execute on function vortex_access.list_organization_invitations_for_administration(
  uuid, integer
) to vortex_request;
grant execute on function vortex_access.read_organization_invitation_for_administration(uuid)
to vortex_request;
grant execute on function vortex_access.read_organization_runtime_settings_for_administration()
to vortex_request;

comment on function vortex_identity.list_organization_accounts_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe account administration projection.';
comment on function vortex_identity.read_organization_account_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe account administration projection.';
comment on function vortex_identity.list_organization_invitations_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe invitation projection without secret or fingerprint.';
comment on function vortex_identity.read_organization_invitation_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe invitation projection without secret or fingerprint.';
comment on function vortex_access.list_organization_accounts_for_administration(uuid, integer) is
  'Protected bounded local-ID account page under the fixed accounts.read decision.';
comment on function vortex_access.read_organization_account_for_administration(uuid) is
  'Protected exact account detail under the fixed accounts.read decision.';
comment on function vortex_access.list_organization_invitations_for_administration(uuid, integer) is
  'Protected bounded local-ID invitation page under the fixed invitations.read decision.';
comment on function vortex_access.read_organization_invitation_for_administration(uuid) is
  'Protected exact invitation detail under the fixed invitations.read decision.';
comment on function vortex_access.read_organization_runtime_settings_for_administration() is
  'Protected explicit-presence runtime-settings read under the fixed runtime_settings.read decision.';
