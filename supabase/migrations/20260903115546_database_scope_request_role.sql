-- The project owner applies migrations. Application traffic uses a login that
-- can establish trusted request context and then enter a non-owning request role.
do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_request') then
    create role vortex_request
      nologin
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls;
  else
    alter role vortex_request
      nologin
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls;
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_runtime') then
    create role vortex_runtime
      login
      password null
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls;
  else
    -- Passwords are provisioned and rotated outside migrations.
    alter role vortex_runtime
      login
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls;
  end if;
end
$roles$;

revoke vortex_request from anon, authenticated, service_role;
grant vortex_request to vortex_runtime with admin false, inherit false, set true;
-- The project owner needs explicit role switching for migrations and controlled pgTAP verification.
-- PostgreSQL automatically gives a role creator ADMIN OPTION. Omitting ADMIN here
-- preserves that creator grant while making the required SET/INHERIT options explicit.
grant vortex_runtime to postgres with inherit false, set true;
grant vortex_request to postgres with inherit false, set true;

do $database_privileges$
begin
  execute format(
    'revoke create on database %I from vortex_runtime, vortex_request',
    current_database()
  );
  execute format('grant connect on database %I to vortex_runtime', current_database());
end
$database_privileges$;

revoke create on schema public from vortex_runtime, vortex_request;

create schema if not exists vortex_context authorization postgres;
revoke all on schema vortex_context from public, anon, authenticated, service_role;
revoke all on schema vortex_context from vortex_runtime, vortex_request;
grant usage on schema vortex_context to vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_context
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_context
  revoke all on sequences from public, anon, authenticated, service_role;
-- Function EXECUTE is granted to PUBLIC by PostgreSQL's global built-in default.
-- A per-schema REVOKE cannot subtract that global privilege, so secure the object
-- owner's function default globally and grant each callable function explicitly.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;

create or replace function vortex_context.is_non_nil_uuid(candidate text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select
    coalesce(
      candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and candidate <> '00000000-0000-0000-0000-000000000000',
      false
    )
$function$;

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
    'callerKind',
    'tenantId',
    'organizationId',
    'sessionId',
    'issuedAt',
    'expiresAt',
    'accessVersion',
    'correlationId',
    'authenticationStrength'
  ] then
    raise exception using errcode = '22023', message = 'Vortex request context is incomplete';
  end if;

  caller_kind := candidate ->> 'callerKind';
  authentication_strength := candidate ->> 'authenticationStrength';

  case caller_kind
    when 'human' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId', 'sessionId',
        'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'identityId', 'organizationAccountId', 'authenticationStrength',
        'delegatedContext', 'supportContext'
      ];
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId', 'sessionId',
        'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'identityId', 'organizationAccountId', 'authenticationStrength'
      ];
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId', 'sessionId',
        'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId', 'sessionId',
        'issuedAt', 'expiresAt', 'accessVersion', 'correlationId', 'authenticationStrength'
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

create or replace function vortex_context.initialize(candidate jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  existing text;
  checked jsonb;
begin
  existing := pg_catalog.current_setting('vortex.request_context', true);
  if existing is not null and existing <> '' then
    raise exception using errcode = '55000', message = 'Vortex request context is already established';
  end if;

  checked := vortex_context.validated(candidate);
  perform pg_catalog.set_config('vortex.request_context', checked::text, true);
end
$function$;

create or replace function vortex_context.current_context()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  stored text;
  parsed jsonb;
begin
  stored := pg_catalog.current_setting('vortex.request_context', true);
  if stored is null or stored = '' then
    raise exception using errcode = '55000', message = 'Vortex request context is not established';
  end if;

  begin
    parsed := stored::jsonb;
  exception when others then
    raise exception using errcode = '22023', message = 'Stored Vortex request context is invalid';
  end;

  return vortex_context.validated(parsed);
end
$function$;

create or replace function vortex_context.organization_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select (vortex_context.current_context() ->> 'organizationId')::uuid
$function$;

create or replace function vortex_context.application_root_id(required boolean default false)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  value text;
begin
  value := vortex_context.current_context() ->> 'applicationRootId';
  if required and value is null then
    raise exception using errcode = '55000', message = 'Vortex application context is required';
  end if;
  return value::uuid;
end
$function$;

revoke execute on function vortex_context.is_non_nil_uuid(text) from public, anon, authenticated, service_role;
revoke execute on function vortex_context.validated(jsonb) from public, anon, authenticated, service_role;
revoke execute on function vortex_context.initialize(jsonb) from public, anon, authenticated, service_role, vortex_request;
revoke execute on function vortex_context.current_context() from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function vortex_context.organization_id() from public, anon, authenticated, service_role, vortex_runtime;
revoke execute on function vortex_context.application_root_id(boolean) from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_context.is_non_nil_uuid(text) to vortex_runtime, vortex_request;
grant execute on function vortex_context.validated(jsonb) to vortex_runtime, vortex_request;
grant execute on function vortex_context.initialize(jsonb) to vortex_runtime;
grant execute on function vortex_context.current_context() to vortex_request;
grant execute on function vortex_context.organization_id() to vortex_request;
grant execute on function vortex_context.application_root_id(boolean) to vortex_request;

comment on schema vortex_context is
  'Private transaction-scoped request context. It is not exposed through the Supabase Data API.';
comment on function vortex_context.initialize(jsonb) is
  'Validates and stores one trusted request context for the current transaction.';
comment on function vortex_context.current_context() is
  'Returns the validated request context or fails closed when it is absent, malformed, or expired.';
