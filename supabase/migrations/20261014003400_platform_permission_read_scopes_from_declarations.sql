set local role vortex_owner;

create or replace function vortex_access.required_platform_permission(p_permission_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  required_permission jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'ownerKind', declaration.owner_kind,
    'ownerId', declaration.owner_id,
    'permissionId', declaration.permission_id
  )
  into strict required_permission
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.permission_key = p_permission_key;

  return required_permission;
exception
  when no_data_found then
    raise exception using errcode = 'P0001',
      message = 'PLATFORM_PERMISSION_DECLARATION_MISSING',
      detail = p_permission_key;
  when too_many_rows then
    raise exception using errcode = 'P0001',
      message = 'PLATFORM_PERMISSION_DECLARATION_AMBIGUOUS',
      detail = p_permission_key;
end
$function$;

alter function vortex_access.required_platform_permission(text) owner to vortex_owner;
revoke all on function vortex_access.required_platform_permission(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.required_platform_permission(text) to postgres, vortex_owner;

create or replace function vortex_access.organization_accounts_administration_scope() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.accounts.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.accounts.read'),
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
$$;

alter function vortex_access.organization_accounts_administration_scope() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.organization_accounts_administration_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_accounts_administration_scope() to postgres;

create or replace function vortex_access.organization_assignment_ledger_administration_scope() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.assignments.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization assignment ledger is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

alter function vortex_access.organization_assignment_ledger_administration_scope() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.organization_assignment_ledger_administration_scope() IS 'Private fixed assignments-read authorization for role assignment and delegation ledger reads.';

REVOKE ALL ON FUNCTION vortex_access.organization_assignment_ledger_administration_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_assignment_ledger_administration_scope() to postgres;

create or replace function vortex_access.organization_groups_administration_scope()
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
      'operationKey', 'platform.organization.groups.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.groups.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization Group administration is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;
alter function vortex_access.organization_groups_administration_scope() owner to vortex_owner;


revoke execute on function vortex_access.organization_groups_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.organization_groups_administration_scope()
  to postgres;

comment on function vortex_access.organization_groups_administration_scope() is
  'Private fixed teams-read authorization for protected Group administration projections.';

alter function vortex_access.organization_groups_administration_scope()
  owner to vortex_owner;

create or replace function vortex_access.organization_invitations_administration_scope() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.invitations.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.invitations.read'),
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
$$;

alter function vortex_access.organization_invitations_administration_scope() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.organization_invitations_administration_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_invitations_administration_scope() to postgres;

create or replace function vortex_access.organization_permissions_administration_scope()
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
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.permissions.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization permission catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke execute on function vortex_access.organization_permissions_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.organization_permissions_administration_scope() is
  'Private fixed permissions-read authorization for the current registered permission catalogue.';

alter function vortex_access.organization_permissions_administration_scope() owner to vortex_owner;

create or replace function vortex_access.organization_roles_administration_scope() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

alter function vortex_access.organization_roles_administration_scope() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.organization_roles_administration_scope() IS 'Private fixed roles-read authorization for current local roles and registered templates.';

REVOKE ALL ON FUNCTION vortex_access.organization_roles_administration_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_roles_administration_scope() to postgres;

reset role;
