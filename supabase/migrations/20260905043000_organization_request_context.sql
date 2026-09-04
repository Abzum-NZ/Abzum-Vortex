-- Issue #27: one URL-selected organisation is resolved from live Identity and
-- Access state, then installed as trusted context in the same transaction.

-- Replace the reached validator in place so the new invariant adds no second
-- callable or privileged validation path.
create or replace function vortex_context.validated(candidate jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller_kind text;
  authentication_strength text;
  issued_at timestamptz;
  expires_at timestamptz;
  allowed_keys text[];
  nested jsonb;
begin
  if candidate is null or pg_catalog.jsonb_typeof(candidate) <> 'object' then
    raise exception using errcode = '22023', message = 'Vortex request context must be an object';
  end if;

  if not candidate ?& array[
    'callerKind', 'tenantId', 'organizationId', 'sessionId', 'issuedAt',
    'expiresAt', 'accessVersion', 'correlationId', 'authenticationStrength'
  ] then
    raise exception using errcode = '22023', message = 'Vortex request context is incomplete';
  end if;

  caller_kind := candidate ->> 'callerKind';
  authentication_strength := candidate ->> 'authenticationStrength';

  case caller_kind
    when 'human' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'delegatedContext', 'supportContext'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_context.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_context.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'authenticationStrength'
      ];
      if authentication_strength is distinct from 'anonymous' then
        raise exception using errcode = '22023', message = 'Vortex public context has an invalid actor';
      end if;
    else
      raise exception using errcode = '22023', message = 'Vortex request context has an unsupported caller kind';
  end case;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(candidate) as supplied(key)
    where not supplied.key = any (allowed_keys)
  ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an unknown field';
  end if;

  if not vortex_context.is_non_nil_uuid(candidate ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'sessionId')
    or not vortex_context.is_non_nil_uuid(candidate ->> 'correlationId')
    or (candidate ? 'applicationRootId' and not vortex_context.is_non_nil_uuid(candidate ->> 'applicationRootId'))
    or (candidate ? 'identityId' and not vortex_context.is_non_nil_uuid(candidate ->> 'identityId'))
    or (candidate ? 'organizationAccountId' and not vortex_context.is_non_nil_uuid(candidate ->> 'organizationAccountId'))
    or (candidate ? 'systemActorId' and not vortex_context.is_non_nil_uuid(candidate ->> 'systemActorId')) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid identifier';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'accessVersion') <> 'number'
    or (candidate ->> 'accessVersion') !~ '^[1-9][0-9]*$'
    or (candidate ->> 'accessVersion')::numeric > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid access version';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'issuedAt') <> 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'expiresAt') <> 'string'
    or (candidate ->> 'issuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or (candidate ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end if;

  begin
    issued_at := (candidate ->> 'issuedAt')::timestamptz;
    expires_at := (candidate ->> 'expiresAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end;

  if not pg_catalog.isfinite(issued_at)
    or not pg_catalog.isfinite(expires_at)
    or expires_at <= issued_at
    or expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '22023', message = 'Vortex request context is expired or inconsistent';
  end if;

  if candidate ? 'delegatedContext' then
    nested := candidate -> 'delegatedContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['delegatedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['delegatedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_context.is_non_nil_uuid(nested ->> 'delegatedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex delegated context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex delegated context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end;
  end if;

  if candidate ? 'supportContext' then
    nested := candidate -> 'supportContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_context.is_non_nil_uuid(nested ->> 'supportActorId')
      or not vortex_context.is_non_nil_uuid(nested ->> 'approvedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex support context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex support context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end;
  end if;

  return candidate;
end
$function$;

revoke execute on function vortex_context.validated(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function vortex_context.validated(jsonb)
  to vortex_runtime, vortex_request;

create function vortex_context.identity_authority_id(required boolean default false)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  value text;
begin
  value := vortex_context.current_context() ->> 'identityAuthorityId';
  if required and value is null then
    raise exception using errcode = '55000', message = 'Vortex Identity Authority context is required';
  end if;
  return value::uuid;
end
$function$;

revoke execute on function vortex_context.identity_authority_id(boolean)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.identity_authority_id(boolean)
  to vortex_request;

create function vortex_identity.list_organization_launcher(p_identity_id uuid)
returns table (
  organization_id uuid,
  tenant_display_name text,
  organization_display_name text,
  account_display_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Launcher identity is invalid';
  end if;

  return query
  select organization.organization_id, tenant.display_name,
    organization.display_name, account.display_name
  from vortex_identity.identity_projections as projection
  join vortex_identity.organization_accounts as account
    on account.identity_id = projection.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where projection.identity_id = p_identity_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  order by tenant.display_name, tenant.tenant_id,
    organization.display_name, organization.organization_id,
    account.display_name nulls last, account.organization_account_id;
end
$function$;

-- Owner-only Identity contract consumed by the Access wrapper below. It is not
-- callable by runtime, request or Supabase Data API roles.
create function vortex_identity.resolve_active_organization_account(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Organisation selection is invalid';
  end if;

  return query
  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id
  from vortex_identity.identity_projections as projection
  join vortex_identity.organization_accounts as account
    on account.identity_id = projection.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where projection.identity_id = p_identity_id
    and organization.organization_id = p_organization_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of projection, account, organization, tenant;
end
$function$;

create function vortex_access.resolve_human_organization_scope(
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
begin
  return query
  select scope.tenant_id, scope.organization_id, scope.organization_account_id,
    version.current_version
  from vortex_identity.resolve_active_organization_account(
    p_identity_id,
    p_organization_id
  ) as scope
  join vortex_access.organization_access_versions as version
    on version.organization_id = scope.organization_id
  for share of version;

  if not found then
    raise exception using errcode = '42501', message = 'Organisation selection is unavailable';
  end if;
end
$function$;

create function vortex_access.validated_human_request_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_identity.validated_human_account_context();

  if not exists (
    select 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked ->> 'organizationId')::uuid
      and version.current_version = (checked ->> 'accessVersion')::bigint
  ) then
    raise exception using errcode = '42501', message = 'Request access version is stale or unavailable';
  end if;

  return checked;
end
$function$;

revoke execute on function vortex_identity.list_organization_launcher(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_identity.list_organization_accounts(uuid)
  from vortex_runtime;
revoke execute on function vortex_identity.resolve_active_organization_account(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.current_organization_access_version(uuid, uuid)
  from vortex_runtime;
revoke execute on function vortex_access.validated_human_request_context()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_identity.list_organization_launcher(uuid)
  to vortex_runtime;
grant execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  to vortex_runtime;
grant usage on schema vortex_access to vortex_request;
grant execute on function vortex_access.validated_human_request_context()
  to vortex_request;

comment on function vortex_context.identity_authority_id(boolean) is
  'Returns the trusted Identity Authority for human/federated context, or fails when required and absent.';
comment on function vortex_identity.list_organization_launcher(uuid) is
  'Returns only safe labels and organisation identifiers for one active identity launcher.';
comment on function vortex_identity.resolve_active_organization_account(uuid, uuid) is
  'Owner-only exact active account and organisation scope used by Access composition.';
comment on function vortex_access.resolve_human_organization_scope(uuid, uuid) is
  'Atomically composes one active Identity scope with its exact live Access version.';
comment on function vortex_access.validated_human_request_context() is
  'Fails closed unless the current human account and Access version are still live.';
