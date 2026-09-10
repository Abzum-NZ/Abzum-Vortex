-- Establish the write form of the protected human request context. It follows
-- every delivered Access writer: the organization Access row is the first
-- mutable governance lock, and Identity is authoritatively rechecked after it.
create function vortex_access.resolve_human_organization_change_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
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
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_organization_account_id uuid;
  locked_access_version bigint;
  authoritative_tenant_id uuid;
  authoritative_organization_id uuid;
  authoritative_organization_account_id uuid;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organisation change selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_organization_account_id, locked_access_version
  from vortex_identity.identity_projections as projection
  join vortex_identity.organization_accounts as account
    on account.identity_id = projection.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where projection.identity_id = p_identity_id
    and organization.organization_id = p_organization_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;

  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation change selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id, scope.organization_account_id
  into authoritative_tenant_id, authoritative_organization_id,
    authoritative_organization_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id,
    p_organization_id
  ) as scope;

  if not found
    or authoritative_tenant_id is distinct from eligible_tenant_id
    or authoritative_organization_id is distinct from eligible_organization_id
    or authoritative_organization_account_id is distinct from
      eligible_organization_account_id then
    raise exception using errcode = '42501',
      message = 'Organisation change selection is unavailable';
  end if;

  return query select authoritative_tenant_id, authoritative_organization_id,
    authoritative_organization_account_id, locked_access_version;
end
$function$;

create function vortex_access.resolve_human_application_change_scope(
  p_identity_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  application_root_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application change selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_change_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  if not exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = resolved_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active'
  ) then
    raise exception using errcode = '42501',
      message = 'Application change selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$function$;

-- This helper is private. Protected read wrappers supply its one fixed
-- declaration; no request chooses a permission or an arbitrary reader.
create function vortex_access.organization_groups_administration_scope()
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
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '290ae49f-4cab-4159-9c20-6e664f07d50b'
      ),
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

create function vortex_access.list_organization_groups_for_administration(
  p_after_group_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  groups jsonb,
  next_after_group_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  group_items jsonb;
  next_group_id uuid;
  page_group_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or (
      p_after_group_id is not null
      and p_after_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    ) then
    raise exception using errcode = '22023',
      message = 'Organization Group page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  with candidates as (
    select organization_group.group_id, organization_group.group_key,
      organization_group.label, organization_group.state,
      organization_group.revision,
      pg_catalog.row_number() over (order by organization_group.group_id) as ordinal
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = scope.organization_id
      and (
        p_after_group_id is null
        or organization_group.group_id > p_after_group_id
      )
    order by organization_group.group_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'groupId', candidate.group_id,
          'key', candidate.group_key,
          'label', candidate.label,
          'state', candidate.state,
          'revision', candidate.revision
        ) order by candidate.group_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.group_id order by candidate.group_id)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into group_items, page_group_ids, candidate_count
  from candidates as candidate;

  next_group_id := case
    when candidate_count > p_page_size then page_group_ids[p_page_size]
    else null
  end;

  return query select scope.organization_id, group_items,
    next_group_id, scope.access_version;
end
$function$;

create function vortex_access.read_organization_group_for_administration(
  p_group_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  group_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  group_value jsonb;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'groupId', organization_group.group_id,
    'key', organization_group.group_key,
    'label', organization_group.label,
    'state', organization_group.state,
    'revision', organization_group.revision
  )
  into group_value
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = scope.organization_id
    and organization_group.group_id = p_group_id;

  return query select scope.organization_id,
    case when group_value is null then 'unavailable' else 'available' end,
    group_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.resolve_human_organization_change_scope(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.resolve_human_application_change_scope(uuid, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.organization_groups_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_organization_groups_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_group_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.resolve_human_organization_change_scope(uuid, uuid)
to vortex_runtime;
grant execute on function
  vortex_access.resolve_human_application_change_scope(uuid, uuid, uuid)
to vortex_runtime;
grant execute on function
  vortex_access.list_organization_groups_for_administration(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_group_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.resolve_human_organization_change_scope(uuid, uuid) is
  'Resolves one active human organization change scope after taking its Access governance lock first and authoritatively rechecking Identity.';
comment on function
  vortex_access.resolve_human_application_change_scope(uuid, uuid, uuid) is
  'Resolves one active human application change scope under the organization Access governance lock.';
comment on function vortex_access.organization_groups_administration_scope() is
  'Private fixed teams-read authorization for protected Group administration projections.';
comment on function
  vortex_access.list_organization_groups_for_administration(uuid, integer) is
  'Returns one bounded stable-ID Group administration page after the fixed teams-read decision.';
comment on function
  vortex_access.read_organization_group_for_administration(uuid) is
  'Returns one safe Group administration detail without exposing current-fact audit evidence.';
