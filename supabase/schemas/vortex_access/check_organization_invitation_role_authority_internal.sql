create or replace function vortex_access.check_organization_invitation_role_authority_internal(
  p_organization_id uuid, p_inviter_id uuid, p_role_id uuid, p_checked_at timestamptz
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  permissions jsonb;
  authority jsonb;
  delegation record;
begin
  select pg_catalog.jsonb_build_object(
    'organizationId', account.organization_id,
    'organizationAccountId', account.organization_account_id,
    'identityId', account.identity_id,
    'expiresAt', p_checked_at + interval '1 day'
  ) into context_value
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity on identity.identity_id = account.identity_id
  join vortex_identity.organizations as organization on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_inviter_id
    and account.state = 'active' and identity.state = 'active'
    and organization.state = 'active' and tenant.state = 'active';
  if context_value is null then return false; end if;

  if not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.invitations.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) or not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) then return false; end if;

  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into permissions
  from (
    select distinct entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id, 'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
        'acceptedRegistrationRevision', entry.accepted_registration_revision,
        'meaningFingerprint', entry.meaning_fingerprint
      )) as permission
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_permission_entries as entry
      on entry.organization_id = role.organization_id and entry.role_id = role.role_id
      and entry.role_revision = role.live_revision
    where role.organization_id = p_organization_id and role.role_id = p_role_id
  ) as reference;
  if permissions is null then return false; end if;
  authority := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management', 'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', permissions)
  );
  select * into strict delegation from vortex_access.evaluate_organization_delegation_internal(
    p_organization_id, p_inviter_id, p_checked_at + interval '1 day', p_checked_at, authority
  );
  return delegation.requirement_count > 0 and delegation.requirement_count = delegation.selected_count;
end
$function$;

alter function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) owner to vortex_owner;
revoke all on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) to postgres, vortex_owner;
