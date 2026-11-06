-- STEPUP-SETTING: an organisation setting that turns the two-step verification requirement off, for
-- development instances only. One mapper (vortex_access.effective_authentication_requirement_internal)
-- reads the setting for every two-step check that reaches the four evaluators; an instance marker
-- the database owns (vortex_platform.instance_profile, default production, written only by local
-- development setup and demo setup through set_instance_profile_internal) decides where the setting
-- may be off, and an off row on any other instance is ignored. Every organisation gets a row set to
-- required (backfilled here; created by provision_tenant and create_tenant_organization). The
-- access-version reason list gains authentication_requirement_changed, the human context may carry
-- the hasSecondFactor fact, and every changed function is replaced as a whole definition identical
-- to its file in supabase/schemas.
set role vortex_owner;

create table if not exists vortex_platform.instance_profile (
  singleton boolean primary key default true check (singleton),
  kind text not null default 'production' check (kind in ('development', 'production'))
);
alter table vortex_platform.instance_profile enable row level security;
alter table vortex_platform.instance_profile force row level security;
revoke all on table vortex_platform.instance_profile
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select on table vortex_platform.instance_profile to postgres;
insert into vortex_platform.instance_profile (singleton, kind) values (true, 'production')
  on conflict (singleton) do nothing;
comment on table vortex_platform.instance_profile is
  'The one row that says whether this database is a development or a production instance. Written only through set_instance_profile_internal by local development setup and demo setup.';

create table if not exists vortex_identity.organization_security_settings (
  organization_id uuid primary key references vortex_identity.organizations(organization_id),
  require_step_up boolean not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  changed_at timestamptz not null,
  changed_by_account_id uuid
);
alter table vortex_identity.organization_security_settings enable row level security;
alter table vortex_identity.organization_security_settings force row level security;
revoke all on table vortex_identity.organization_security_settings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select on table vortex_identity.organization_security_settings to postgres;
comment on table vortex_identity.organization_security_settings is
  'The organisation security settings: whether two-step verification is required, one row per organisation, read and changed only through vortex_access functions.';

insert into vortex_identity.organization_security_settings (
  organization_id, require_step_up, revision, changed_at, changed_by_account_id
)
select organization.organization_id, true, 1, pg_catalog.statement_timestamp(), null
from vortex_identity.organizations as organization
on conflict (organization_id) do nothing;

alter table vortex_access.organization_access_versions
  drop constraint organization_access_versions_reason_valid,
  add constraint organization_access_versions_reason_valid check (change_reason = any (array[
    'organization_initialized', 'organization_account_activated',
    'organization_account_reactivated', 'organization_account_suspended',
    'organization_account_closed', 'role_assignment_changed',
    'delegation_changed', 'stewardship_changed', 'invitation_access_accepted',
    'role_catalogue_changed', 'group_membership_changed', 'application_access_changed',
    'record_ownership_changed', 'access_grant_changed', 'public_policy_changed',
    'federation_mirror_changed', 'mcp_authorization_changed',
    'authentication_requirement_changed'
  ]::text[]));

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
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed',
      'authentication_requirement_changed'
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

alter function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) FROM PUBLIC;

grant execute on function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) to postgres;

create or replace function vortex_platform.validated(candidate jsonb)
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
  access_token_issued_at timestamptz;
  primary_authenticated_at timestamptz;
  multi_factor_authenticated_at timestamptz;
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
        'authenticationStrength', 'accessTokenIssuedAt', 'primaryAuthenticatedAt',
        'multiFactorAuthenticatedAt', 'hasSecondFactor', 'delegatedContext',
        'supportContext', 'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext', 'channel'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'authenticationStrength', 'channel'
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

  -- The fact that the person has a verified second factor, set by the trusted entry point only for
  -- the requests that need it; absent means the person is treated as enrolled.
  if candidate ? 'hasSecondFactor'
    and pg_catalog.jsonb_typeof(candidate -> 'hasSecondFactor') <> 'boolean' then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid second-factor fact';
  end if;

  if candidate ? 'channel'
    and (
      pg_catalog.jsonb_typeof(candidate -> 'channel') <> 'string'
      or (candidate ->> 'channel') <> all (array[
        'web', 'webmcp', 'programmatic_interface', 'connection', 'federation',
        'system'
      ])
    ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid channel';
  end if;

  if not vortex_platform.is_non_nil_uuid(candidate ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'sessionId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'correlationId')
    or (candidate ? 'applicationRootId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'applicationRootId'))
    or (candidate ? 'identityId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'identityId'))
    or (candidate ? 'organizationAccountId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationAccountId'))
    or (candidate ? 'systemActorId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'systemActorId')) then
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

  if caller_kind = 'human' then
    if (candidate ? 'accessTokenIssuedAt')
      <> (candidate ? 'primaryAuthenticatedAt' or candidate ? 'multiFactorAuthenticatedAt') then
      raise exception using errcode = '22023', message = 'Vortex human authentication evidence is incomplete';
    end if;

    if candidate ? 'accessTokenIssuedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'accessTokenIssuedAt') <> 'string'
        or (candidate ->> 'accessTokenIssuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        access_token_issued_at := (candidate ->> 'accessTokenIssuedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(access_token_issued_at)
        or access_token_issued_at >= expires_at
        or access_token_issued_at > issued_at + interval '60 seconds' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'primaryAuthenticatedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'primaryAuthenticatedAt') <> 'string'
        or (candidate ->> 'primaryAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        primary_authenticated_at := (candidate ->> 'primaryAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(primary_authenticated_at)
        or primary_authenticated_at > access_token_issued_at
        or primary_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'multiFactorAuthenticatedAt' then
      if authentication_strength <> 'multi_factor' then
        raise exception using errcode = '22023', message = 'Vortex human multi-factor evidence conflicts with authentication strength';
      end if;
      if pg_catalog.jsonb_typeof(candidate -> 'multiFactorAuthenticatedAt') <> 'string'
        or (candidate ->> 'multiFactorAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        multi_factor_authenticated_at := (candidate ->> 'multiFactorAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(multi_factor_authenticated_at)
        or multi_factor_authenticated_at > access_token_issued_at
        or multi_factor_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;
  end if;

  if candidate ? 'delegatedContext' then
    nested := candidate -> 'delegatedContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['delegatedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['delegatedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_platform.is_non_nil_uuid(nested ->> 'delegatedByOrganizationAccountId')
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
      or not vortex_platform.is_non_nil_uuid(nested ->> 'supportActorId')
      or not vortex_platform.is_non_nil_uuid(nested ->> 'approvedByOrganizationAccountId')
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

revoke execute on function vortex_platform.validated(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_platform.validated(jsonb) is
  'Validates one trusted request context, including its optional trusted channel, or fails closed.';

alter function vortex_platform.validated(candidate jsonb) owner to vortex_owner;

grant execute on function vortex_platform.validated(candidate jsonb) to postgres;

create or replace function vortex_platform.set_instance_profile_internal(p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_kind is null or p_kind not in ('development', 'production') then
    raise exception using errcode = '22023', message = 'Instance profile kind is invalid';
  end if;
  update vortex_platform.instance_profile as profile
  set kind = p_kind
  where profile.singleton;
  if not found then
    raise exception using errcode = '55000', message = 'Instance profile is unavailable';
  end if;
end
$function$;

comment on function vortex_platform.set_instance_profile_internal(text) is
  'Marks this database as a development or production instance. Only local development setup and demo setup call it, as the owner; no request role can execute it.';

revoke all on function vortex_platform.set_instance_profile_internal(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_platform.set_instance_profile_internal(p_kind text) owner to vortex_owner;

grant execute on function vortex_platform.set_instance_profile_internal(p_kind text) to postgres;

create or replace function vortex_access.effective_authentication_requirement_internal(
  p_organization_id uuid,
  p_requirement jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- Only a two-step requirement is ever relaxed, and only here. A requirement of any other kind,
  -- a missing organisation, a missing settings row and every other case keep the requirement as
  -- declared, so two-step verification stays required.
  if p_organization_id is null
    or p_requirement ->> 'kind' is distinct from 'multi_factor' then
    return p_requirement;
  end if;
  if exists (
      select 1
      from vortex_platform.instance_profile as profile
      where profile.kind = 'development'
    )
    and exists (
      select 1
      from vortex_identity.organization_security_settings as setting
      where setting.organization_id = p_organization_id
        and setting.require_step_up is false
    ) then
    -- The recent sign-in is never relaxed: it keeps the declared age.
    return pg_catalog.jsonb_build_object(
      'kind', 'primary', 'maximumAgeSeconds', p_requirement -> 'maximumAgeSeconds'
    );
  end if;
  return p_requirement;
end
$function$;

comment on function vortex_access.effective_authentication_requirement_internal(uuid, jsonb) is
  'The one place that reads the organisation two-step setting. A two-step requirement becomes a recent sign-in of the same age only on a development instance whose organisation turned the requirement off; everything else is returned as declared. The organisation comes only from the validated context. No request role can execute it.';

revoke all on function vortex_access.effective_authentication_requirement_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_access.effective_authentication_requirement_internal(p_organization_id uuid, p_requirement jsonb) owner to vortex_owner;

grant execute on function vortex_access.effective_authentication_requirement_internal(p_organization_id uuid, p_requirement jsonb) to postgres;

create or replace function vortex_access.evaluate_organization_permission_eligibility(
  p_declaration jsonb
)
returns table (
  outcome text,
  operation_key text,
  target_kind text,
  target_application_root_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  checked_at timestamptz,
  valid_until timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permission jsonb;
  declaration_authentication jsonb;
  effective_authentication jsonb;
  declaration_authority jsonb;
  scope_candidate jsonb;
  permission_candidate jsonb;
  scope_name text;
  operation_value text;
  target_kind_value text;
  target_application_value uuid;
  permission_application_value uuid;
  permission_owner_kind_value text;
  authority_kind_value text;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermission',
      'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermission',
        'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permission := p_declaration -> 'requiredPermission';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' not in ('organization', 'application')
    or (
      declaration_target ->> 'kind' = 'organization'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_target ->> 'kind' = 'application'
      and (
        not declaration_target ? 'applicationRootId'
        or not vortex_platform.is_non_nil_uuid(
          declaration_target ->> 'applicationRootId'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
          where supplied.key <> all (array['kind', 'applicationRootId'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' not in ('permission', 'delegated_management')
    or (
      declaration_authority ->> 'kind' = 'permission'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authority ->> 'kind' = 'delegated_management'
      and (
        not declaration_authority ?& array['before', 'after']
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
          where supplied.key <> all (array['kind', 'before', 'after'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if pg_catalog.jsonb_typeof(scope_candidate) <> 'object'
        or not scope_candidate ? 'kind'
        or pg_catalog.jsonb_typeof(scope_candidate -> 'kind') <> 'string'
        or scope_candidate ->> 'kind' not in (
          'none', 'organization_catalogue', 'bounded'
        )
        or (
          scope_candidate ->> 'kind' in ('none', 'organization_catalogue')
          and exists (
            select 1
            from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
            where supplied.key <> 'kind'
          )
        )
        or (
          scope_candidate ->> 'kind' = 'bounded'
          and (
            not scope_candidate ? 'permissions'
            or pg_catalog.jsonb_typeof(scope_candidate -> 'permissions') <> 'array'
            or pg_catalog.jsonb_array_length(scope_candidate -> 'permissions') = 0
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
              where supplied.key <> all (array['kind', 'permissions'])
            )
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;

    if declaration_authority -> 'before' ->> 'kind' = 'none'
      and declaration_authority -> 'after' ->> 'kind' = 'none' then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end if;

  for permission_candidate in
    select candidate.value
    from (
      select declaration_permission as value
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'before' ->> 'kind' = 'bounded'
          then declaration_authority -> 'before' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'after' ->> 'kind' = 'bounded'
          then declaration_authority -> 'after' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
    ) as candidate
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array['ownerKind', 'ownerId', 'permissionId']
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('platform', 'application', 'module')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision'
        ])
      )
      or (permission_candidate ? 'acceptedRegistrationRevision' and (
        pg_catalog.jsonb_typeof(permission_candidate -> 'acceptedRegistrationRevision') <> 'number'
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric
          not between 1 and 9007199254740991
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc((permission_candidate ->> 'acceptedRegistrationRevision')::numeric)
      ))
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_platform.is_non_nil_uuid(
            permission_candidate ->> 'applicationRootId'
          )
        )
      )
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end loop;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if scope_candidate ->> 'kind' = 'bounded'
        and (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(scope_candidate -> 'permissions')
        ) <> (
          select pg_catalog.count(distinct pg_catalog.concat_ws(
            ':',
            pg_catalog.lower(permission.value ->> 'applicationRootId'),
            permission.value ->> 'ownerKind',
            pg_catalog.lower(permission.value ->> 'ownerId'),
            pg_catalog.lower(permission.value ->> 'permissionId'),
            permission.value ->> 'acceptedRegistrationRevision'
          ))
          from pg_catalog.jsonb_array_elements(
            scope_candidate -> 'permissions'
          ) as permission(value)
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;
  end if;

  operation_value := p_declaration ->> 'operationKey';
  target_kind_value := declaration_target ->> 'kind';
  target_application_value := case
    when target_kind_value = 'application'
      then (declaration_target ->> 'applicationRootId')::uuid
    else null
  end;
  permission_application_value := case
    when declaration_permission ? 'applicationRootId'
      then (declaration_permission ->> 'applicationRootId')::uuid
    else null
  end;
  permission_owner_kind_value := declaration_permission ->> 'ownerKind';
  authority_kind_value := declaration_authority ->> 'kind';

  if (target_kind_value = 'organization' and permission_owner_kind_value <> 'platform')
    or (
      target_kind_value = 'application'
      and (
        permission_owner_kind_value = 'platform'
        or permission_application_value is distinct from target_application_value
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := pg_catalog.clock_timestamp();
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := target_kind_value = 'organization'
    or coalesce(context_application_value = target_application_value, false);

  -- The organisation comes only from the validated context. The effective requirement is
  -- the declared one unless the organisation turned two-step verification off on a
  -- development instance; the deadline and the refusal reason both follow it.
  effective_authentication := vortex_access.effective_authentication_requirement_internal(
    context_organization_value, declaration_authentication
  );
  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, effective_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  return query
  with permission_eligibility as materialized (
    select evaluated.path_valid_until
    from vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declaration_permission,
      declaration_action, null::uuid
    ) as evaluated
  ), delegation_summary as (
    select * from vortex_access.evaluate_organization_delegation_internal(
      context_organization_value, context_account_value, context_expires_value,
      decision_checked_at, declaration_authority
    )
  ), decision as (
    select exists(select 1 from permission_eligibility) as permission_available,
      (
        select pg_catalog.min(selected.path_valid_until)
        from permission_eligibility as selected
      ) as path_valid_until,
      authority_kind_value = 'permission'
        or (
          delegation.requirement_count > 0
          and delegation.requirement_count = delegation.selected_count
        ) as delegation_satisfied,
      delegation.path_valid_until as delegation_valid_until
    from (select 1) as singleton
    cross join delegation_summary as delegation
  )
  select
    case
      when not context_current
        or unsupported_context or not target_context_satisfied then 'refused'
      when not decision.permission_available then 'refused'
      when decision.path_valid_until is null then 'refused'
      when not authentication_satisfied then 'refused'
      when not decision.delegation_satisfied then 'refused'
      else 'eligible'
    end,
    operation_value,
    target_kind_value,
    target_application_value,
    context_organization_value,
    context_account_value,
    context_access_version_value,
    decision_checked_at,
    case
      when context_current
        and not unsupported_context
        and target_context_satisfied
        and decision.permission_available
        and decision.path_valid_until is not null
        and authentication_satisfied
        and decision.delegation_satisfied
      then least(
        decision.path_valid_until,
        authentication_deadline,
        coalesce(decision.delegation_valid_until, context_expires_value)
      )
      else null
    end,
    context_correlation_value,
    case
      when not context_current
        or unsupported_context or not target_context_satisfied
        then 'target_policy_unavailable'
      when not decision.permission_available then 'permission_unavailable'
      when decision.path_valid_until is null then 'permission_not_effective'
      when not authentication_satisfied and effective_authentication ->> 'kind' = 'multi_factor'
        then 'multi_factor_unsatisfied'
      when not authentication_satisfied then 'authentication_unsatisfied'
      when not decision.delegation_satisfied then 'delegation_insufficient'
      else null
    end
  from decision;
end
$function$;

revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_owner, postgres;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permissions jsonb;
  declaration_binding jsonb;
  declaration_authentication jsonb;
  effective_authentication jsonb;
  declaration_authority jsonb;
  permission_candidate jsonb;
  previous_identity text;
  candidate_identity text;
  operation_value text;
  action_kind_value text;
  target_application_value uuid;
  binding_record_type_value uuid;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
  catalogue_available boolean := false;
  scoped_available boolean := false;
  path_effective boolean := false;
  eligible_permissions jsonb;
  eligible_valid_until timestamptz;
  refusal_reason text;
  evidence jsonb;
  requirement jsonb;
  requirement_candidate record;
  requirement_granted record;
  requirement_valid_until timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermissions',
      'recordBinding', 'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermissions',
        'recordBinding', 'recentAuthentication', 'authority', 'contributorRequirements'
      ])
    )
    or (
      p_declaration ? 'contributorRequirements'
      and (
        pg_catalog.jsonb_typeof(p_declaration -> 'contributorRequirements') <> 'array'
        or pg_catalog.jsonb_array_length(p_declaration -> 'contributorRequirements') not between 1 and 10
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_declaration -> 'contributorRequirements') as item(value)
          where pg_catalog.jsonb_typeof(item.value) <> 'object'
            or not item.value ?& array[
              'moduleRootId', 'applicationRootIds', 'recordTypeId', 'permissionKeys', 'changeableFieldIds'
            ]
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(item.value) as supplied(key)
              where supplied.key <> all (array[
                'moduleRootId', 'applicationRootIds', 'recordTypeId', 'permissionKeys', 'changeableFieldIds'
              ])
            )
            or not vortex_platform.is_non_nil_uuid(item.value ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
            or pg_catalog.jsonb_typeof(item.value -> 'applicationRootIds') <> 'array'
            or pg_catalog.jsonb_typeof(item.value -> 'permissionKeys') <> 'array'
            or pg_catalog.jsonb_typeof(item.value -> 'changeableFieldIds') <> 'array'
        )
      )
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permissions := p_declaration -> 'requiredPermissions';
  declaration_binding := p_declaration -> 'recordBinding';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'transfer', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ?& array['kind', 'applicationRootId']
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
      where supplied.key <> all (array['kind', 'applicationRootId'])
    )
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' <> 'application'
    or not vortex_platform.is_non_nil_uuid(
      declaration_target ->> 'applicationRootId'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_binding) <> 'object'
    or not declaration_binding ?& array[
      'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_binding) as supplied(key)
      where supplied.key <> all (array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'
      ])
    )
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(declaration_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(
      declaration_binding ->> 'storageContractId'
    )
    or pg_catalog.jsonb_typeof(declaration_binding -> 'storageScope') <> 'string'
    or declaration_binding ->> 'storageScope' not in (
      'organization_shared', 'application_contained'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  -- A record operation carries ordinary permission authority only; delegated
  -- management scopes stay on the existing non-record path.
  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' <> 'permission'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
      where supplied.key <> 'kind'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(declaration_permissions) = 0 then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  previous_identity := null;
  for permission_candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array[
        'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
      ]
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('application', 'module')
      or not vortex_platform.is_non_nil_uuid(
        permission_candidate ->> 'applicationRootId'
      )
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or pg_catalog.lower(permission_candidate ->> 'applicationRootId') <>
        pg_catalog.lower(declaration_target ->> 'applicationRootId')
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      )
      or (
        permission_candidate ->> 'ownerKind' = 'module'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(declaration_binding ->> 'moduleRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;

    candidate_identity := pg_catalog.concat_ws(
      ':',
      pg_catalog.lower(permission_candidate ->> 'applicationRootId'),
      permission_candidate ->> 'ownerKind',
      pg_catalog.lower(permission_candidate ->> 'ownerId'),
      pg_catalog.lower(permission_candidate ->> 'permissionId')
    );
    if previous_identity is not null
      and previous_identity collate "C" >= candidate_identity then
      raise exception using errcode = '22023',
        message = 'Organization record permission declaration is invalid';
    end if;
    previous_identity := candidate_identity;
  end loop;

  operation_value := p_declaration ->> 'operationKey';
  action_kind_value := declaration_action ->> 'actionKind';
  target_application_value := (declaration_target ->> 'applicationRootId')::uuid;
  binding_record_type_value := (declaration_binding ->> 'recordTypeId')::uuid;

  if action_kind_value = 'named'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(declaration_permissions) as item(value)
      where item.value ->> 'ownerKind' <>
          declaration_permissions -> 0 ->> 'ownerKind'
        or pg_catalog.lower(item.value ->> 'ownerId') <>
          pg_catalog.lower(declaration_permissions -> 0 ->> 'ownerId')
    ) then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  context_value := p_context;
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := p_checked_at;
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := coalesce(
    context_application_value = target_application_value, false
  );

  -- The organisation comes only from the validated context. The effective requirement is
  -- the declared one unless the organisation turned two-step verification off on a
  -- development instance; the deadline and the refusal reason both follow it.
  effective_authentication := vortex_access.effective_authentication_requirement_internal(
    context_organization_value, declaration_authentication
  );
  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, effective_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  -- Every declared alternative is evaluated against its exact record type by the
  -- shared role-path helper under this one context and checked time. A candidate
  -- keeps its own catalogue record scope, immutable source release and path
  -- deadline; an alternative never lends authority to another. Keeping
  -- path_valid_until separate from authentication_deadline here (instead of
  -- combining them per row) is what lets the three existence flags below tell
  -- "no catalogue entry", "entry without record scope" and "scoped entry
  -- without a live path" apart as distinct refusal reasons.
  with candidate as (
    select declared.ordinality as alternative_ordinal,
      -- A preview's system projection uses the builder's live registration. Keep that
      -- registration's permission address with its accepted meaning for every later reader.
      pg_catalog.jsonb_build_object(
        'applicationRootId', (evaluated.permission_entry).application_root_id,
        'ownerKind', (evaluated.permission_entry).owner_kind,
        'ownerId', (evaluated.permission_entry).owner_id,
        'permissionId', (evaluated.permission_entry).permission_id
      ) as permission_value,
      (evaluated.permission_entry).registration_revision as registration_revision,
      (evaluated.permission_entry).record_scope as record_scope,
      pg_catalog.jsonb_build_object(
        'kind', (evaluated.permission_entry).source_kind,
        'definitionKey', (evaluated.permission_entry).source_definition_key,
        'rootId', (evaluated.permission_entry).source_root_id,
        'releaseRevision', (evaluated.permission_entry).source_revision,
        'releaseVersion', (evaluated.permission_entry).source_version,
        'validationContractVersion',
          (evaluated.permission_entry).source_validation_contract_version
      ) as source_release,
      evaluated.path_valid_until as path_valid_until
    from pg_catalog.jsonb_array_elements(declaration_permissions)
      with ordinality as declared(value, ordinality)
    cross join lateral vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declared.value, declaration_action,
      binding_record_type_value
    ) as evaluated
  )
  select pg_catalog.count(*) > 0,
    pg_catalog.count(*) filter (where candidate.record_scope is not null) > 0,
    pg_catalog.count(*) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
    ) > 0,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'permission', candidate.permission_value,
        'registrationRevision', candidate.registration_revision,
        'recordScope', candidate.record_scope,
        'source', candidate.source_release,
        'validUntil', pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', least(candidate.path_valid_until, authentication_deadline)
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by candidate.alternative_ordinal
    ) filter (
      where candidate.record_scope is not null
        and candidate.path_valid_until is not null
        and authentication_deadline is not null
    ),
    pg_catalog.min(least(candidate.path_valid_until, authentication_deadline))
      filter (
        where candidate.record_scope is not null
          and candidate.path_valid_until is not null
          and authentication_deadline is not null
      )
  into catalogue_available, scoped_available, path_effective, eligible_permissions,
    eligible_valid_until
  from candidate;

  evidence := pg_catalog.jsonb_build_object(
    'operationKey', operation_value,
    'target', declaration_target,
    'organizationId', context_organization_value,
    'organizationAccountId', context_account_value,
    'accessVersion', context_access_version_value,
    'checkedAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', decision_checked_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_value,
    'recordBinding', declaration_binding
  );

  -- Refusal precedence keeps each cause distinguishable: an unsupported
  -- context always wins; then "no candidate has any catalogue entry"; then
  -- "entries exist but none carries record_scope"; then "scoped entries exist
  -- but none has a live role path"; only then does recent-authentication
  -- refuse an otherwise-complete set of alternatives.
  refusal_reason := case
    when not context_current
      or unsupported_context or not target_context_satisfied
      then 'target_policy_unavailable'
    when not catalogue_available then 'permission_unavailable'
    when not scoped_available then 'target_policy_unavailable'
    when not path_effective then 'permission_not_effective'
    when not authentication_satisfied and effective_authentication ->> 'kind' = 'multi_factor'
        then 'multi_factor_unsatisfied'
      when not authentication_satisfied then 'authentication_unsatisfied'
    else null
  end;

  if refusal_reason is not null then
    return evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', refusal_reason
    );
  end if;

  -- Another installed Module that contributed what this operation acts on adds its own
  -- requirement to the owner's: the person must also hold, through a current role path, a
  -- permission that Module declared for the operation, whose record scope is unconditional and
  -- whose field policy lets the person change every field the operation changes. The owner's
  -- permissions above still decide the record; this only narrows who may use the contribution.
  if p_declaration ? 'contributorRequirements' then
    for requirement in
      select item.value
      from pg_catalog.jsonb_array_elements(p_declaration -> 'contributorRequirements') as item(value)
    loop
      requirement_valid_until := null;
      for requirement_candidate in
        select distinct entry.application_root_id, entry.owner_kind, entry.owner_id,
          entry.permission_id, entry.record_type_id, entry.named_action
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = context_organization_value
          and entry.registration_kind = 'application'
          and entry.owner_kind = 'module'
          and entry.owner_id = (requirement ->> 'moduleRootId')::uuid
          and entry.record_type_id = (requirement ->> 'recordTypeId')::uuid
          and entry.action_kind = 'named'
          and entry.application_root_id in (
            select pg_catalog.lower(application.value)::uuid
            from pg_catalog.jsonb_array_elements_text(requirement -> 'applicationRootIds') as application(value)
          )
          and entry.permission_key in (
            select permission_key.value
            from pg_catalog.jsonb_array_elements_text(requirement -> 'permissionKeys') as permission_key(value)
          )
        order by entry.application_root_id, entry.permission_id
      loop
        for requirement_granted in
          select path.permission_entry, path.path_valid_until
          from vortex_access.evaluate_permission_role_path_internal(
            context_value, decision_checked_at,
            pg_catalog.jsonb_build_object(
              'applicationRootId', requirement_candidate.application_root_id,
              'ownerKind', requirement_candidate.owner_kind,
              'ownerId', requirement_candidate.owner_id,
              'permissionId', requirement_candidate.permission_id
            ),
            pg_catalog.jsonb_build_object(
              'actionKind', 'named', 'namedAction', requirement_candidate.named_action
            ),
            requirement_candidate.record_type_id
          ) as path
        loop
          if requirement_granted.path_valid_until is null
            or requirement_granted.path_valid_until <= decision_checked_at
            or pg_catalog.jsonb_typeof((requirement_granted.permission_entry).record_scope) is distinct from 'object'
            or (requirement_granted.permission_entry).record_scope ? 'savedCondition'
            or not coalesce(
              (requirement_granted.permission_entry).record_scope -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
              false
            )
            or pg_catalog.jsonb_typeof((requirement_granted.permission_entry).field_policy) is distinct from 'object'
            or exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(requirement -> 'changeableFieldIds') as required_field(value)
              where not exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  (requirement_granted.permission_entry).field_policy -> 'changeableFieldIds'
                ) as allowed_field(value)
                where pg_catalog.lower(allowed_field.value) = pg_catalog.lower(required_field.value)
              )
            ) then
            continue;
          end if;
          requirement_valid_until := greatest(
            coalesce(requirement_valid_until, requirement_granted.path_valid_until),
            requirement_granted.path_valid_until
          );
        end loop;
      end loop;
      if requirement_valid_until is null then
        return evidence || pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', 'permission_not_effective'
        );
      end if;
      eligible_valid_until := least(eligible_valid_until, requirement_valid_until);
    end loop;
  end if;

  return evidence || pg_catalog.jsonb_build_object(
    'outcome', 'eligible',
    'validUntil', pg_catalog.to_char(
      pg_catalog.timezone('UTC', eligible_valid_until),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'eligiblePermissions', eligible_permissions
  );
end
$_$;

ALTER FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) OWNER TO vortex_owner;

COMMENT ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) IS 'Private record-permission eligibility evidence per declared alternative; carries the declared record binding as context and is never a record allow result. The caller supplies one Access-bound context and checked time.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) TO vortex_owner;

grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to postgres;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(p_declaration jsonb, p_context jsonb, p_checked_at timestamp with time zone) to vortex_record_adapter;

create or replace function vortex_access.evaluate_organization_record_access_page_internal(
  p_rows jsonb,
  p_jobs jsonb,
  p_envelope jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  jobs jsonb := p_jobs;
  context_value jsonb;
  checked_at timestamptz;
  decisions jsonb;
  -- The page-wide facts every compact row shares (the page envelope's facts).
  envelope_facts jsonb := p_envelope -> 'facts';
begin
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 200
    or pg_catalog.jsonb_typeof(jobs) is distinct from 'array'
    or pg_catalog.jsonb_array_length(jobs) > 600
    or (p_envelope is not null and (pg_catalog.jsonb_typeof(p_envelope -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(envelope_facts) is distinct from 'object')) then
    raise exception using errcode = '22023', message = 'Page access jobs are invalid';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(jobs) as job(value)
    where pg_catalog.jsonb_typeof(job.value) is distinct from 'object'
      or not (job.value ?& array['rowIndex', 'actionKind', 'requiredPermissions'])
      or pg_catalog.jsonb_typeof(job.value -> 'rowIndex') is distinct from 'number'
      or (job.value ->> 'rowIndex') !~ '^[1-9][0-9]*$'
      or (job.value ->> 'rowIndex')::integer > pg_catalog.jsonb_array_length(p_rows)
      or job.value ->> 'actionKind' not in ('update', 'delete', 'restore')
      or pg_catalog.jsonb_typeof(job.value -> 'requiredPermissions') is distinct from 'array'
  ) or (p_envelope is null and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_rows) as row_item(value)
    where pg_catalog.jsonb_typeof(row_item.value) = 'object'
      and row_item.value ? 'record' and not (row_item.value ? 'readFacts')
  )) then
    raise exception using errcode = '22023', message = 'Page access jobs are invalid';
  end if;
  if jobs = '[]'::jsonb then
    return jobs;
  end if;
  context_value := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
    -- Each declaration is eligible once for the page. Every record still
    -- receives the exact row-scope, ownership, group and share decision. A
    -- compact row (from the page read pass) carries only its own record fact;
    -- its page-wide facts are the one page envelope's, never copied per job.
    with page_rows as materialized (
      select row_item.ordinality::integer as row_index,
        (row_item.value ->> 'recordId')::uuid as record_id,
        row_item.value ? 'record' and not (row_item.value ? 'readFacts') as is_compact,
        row_item.value -> 'readFacts' -> 'declaration' as own_declaration,
        row_item.value -> 'readFacts' -> 'facts' as own_facts,
        row_item.value -> 'record' -> 'record' as own_record
      from pg_catalog.jsonb_array_elements(p_rows) with ordinality as row_item(value, ordinality)
    ),
    page_jobs as materialized (
      select (job.value ->> 'rowIndex')::integer as row_index,
        job.value ->> 'actionKind' as action_kind,
        job.value -> 'requiredPermissions' as required_permissions
      from pg_catalog.jsonb_array_elements(jobs) as job(value)
    ),
    entries as materialized (
      select job.row_index, job.action_kind, page_row.record_id, page_row.is_compact,
        (case when page_row.is_compact then p_envelope -> 'declaration'
          else page_row.own_declaration end)
          || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || job.action_kind,
            'action', pg_catalog.jsonb_build_object('actionKind', job.action_kind),
            'requiredPermissions', job.required_permissions
          ) as declaration,
        case when not page_row.is_compact then page_row.own_facts end as facts,
        case when page_row.is_compact then page_row.own_record end as own_record
      from page_jobs as job
      join page_rows as page_row on page_row.row_index = job.row_index
    ),
    declarations as materialized (
      select distinct entry.declaration from entries as entry
    ),
    eligible as materialized (
      select declaration,
        vortex_access.evaluate_organization_record_permission_eligibility_internal(
          declaration, context_value, checked_at
        ) as value
      from declarations
    ),
    assessed as (
      select entry.row_index, entry.action_kind, entry.record_id, entry.is_compact,
        entry.declaration, entry.facts, entry.own_record, eligible.value as eligibility,
        target.value as target_record,
        target.value is not null
          and (target.value -> 'recordScope' ->> 'organizationId')::uuid
            = (context_value ->> 'organizationId')::uuid
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'moduleRootId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'moduleRootId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'recordTypeId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'recordTypeId')
          and pg_catalog.lower(target.value -> 'recordScope' ->> 'storageContractId')
            = pg_catalog.lower(coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageContractId')
          and target.value -> 'recordScope' ->> 'storageScope'
            = coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageScope'
          and (
            coalesce(entry.facts, envelope_facts) -> 'binding' ->> 'storageScope' = 'organization_shared'
            or (target.value -> 'recordScope' ->> 'applicationRootId')::uuid
              = (entry.declaration -> 'target' ->> 'applicationRootId')::uuid
          )
          and target.value ->> 'lifecycleState' = 'active' as target_ok
      from entries as entry
      join eligible on eligible.declaration = entry.declaration
      left join lateral (
        select item.value
        from pg_catalog.jsonb_array_elements(
          case when entry.is_compact then pg_catalog.jsonb_build_array(entry.own_record)
            else entry.facts -> 'records' end
        ) as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = entry.record_id
        limit 1
      ) as target on true
    ),
    -- Records whose routes all have an exact set form are decided together,
    -- per declaration, in one pass; the rest keep the composition below.
    -- Eligibility is a function of the declaration; the record types are
    -- grouped by their text so equal sets are compared once, not sorted.
    grouped as materialized (
      select assessed.declaration,
        (pg_catalog.array_agg(assessed.eligibility))[1] as eligibility,
        (pg_catalog.array_agg(coalesce(assessed.facts, envelope_facts) -> 'recordTypes'))[1] as record_types,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(assessed.row_index, assessed.action_kind)
          order by assessed.row_index, assessed.action_kind) as keys,
        pg_catalog.jsonb_agg(coalesce(assessed.target_record, 'null'::jsonb)
          order by assessed.row_index, assessed.action_kind) as records
      from assessed
      -- Compact rows share the envelope's record types: one group per declaration.
      group by assessed.declaration, assessed.is_compact,
        (case when not assessed.is_compact then (assessed.facts -> 'recordTypes')::text end)
    ),
    decided as materialized (
      select (grouped.keys -> (set_decision.ordinality::integer - 1) ->> 0)::integer as row_index,
        grouped.keys -> (set_decision.ordinality::integer - 1) ->> 1 as action_kind,
        set_decision.value as decision
      from grouped
      cross join lateral pg_catalog.jsonb_array_elements(
        vortex_access.decide_record_page_scope_internal(
          context_value, checked_at, grouped.declaration, grouped.eligibility,
          grouped.record_types, grouped.records, false
        )
      ) with ordinality as set_decision(value, ordinality)
      where set_decision.value <> 'null'::jsonb
    ),
    scoped as (
      select assessed.*, decided.decision as set_decision,
        case when decided.decision is null
          and assessed.eligibility ->> 'outcome' = 'eligible'
          and assessed.target_ok then (
            select coalesce(pg_catalog.jsonb_agg(
              contribution.value order by
                alt.ordinality,
                case contribution.value -> 'route' ->> 'kind'
                  when 'all_records' then 0
                  when 'ownership' then 1
                  when 'relationship' then 3
                end,
                coalesce(contribution.value -> 'route' ->> 'sourceRecordId', '')
            ), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(
              assessed.eligibility -> 'eligiblePermissions'
            ) with ordinality as alt(value, ordinality)
            cross join lateral pg_catalog.jsonb_array_elements(
              vortex_access.evaluate_record_permission_row_scope_internal(
                context_value, checked_at,
                vortex_access.recent_authentication_deadline_internal(
                  context_value, checked_at,
                  vortex_access.effective_authentication_requirement_internal(
                    (context_value ->> 'organizationId')::uuid,
                    assessed.declaration -> 'recentAuthentication'
                  )
                ),
                (assessed.declaration -> 'target' ->> 'applicationRootId')::uuid,
                assessed.declaration -> 'action', alt.value, assessed.record_id,
                case when assessed.is_compact
                  then pg_catalog.jsonb_set(envelope_facts, '{records}',
                    pg_catalog.jsonb_build_array(assessed.own_record))
                  else assessed.facts end,
                array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
              )
            ) as contribution(value)
          )
          else '[]'::jsonb end as matched
      from assessed
      left join decided
        on decided.row_index = assessed.row_index and decided.action_kind = assessed.action_kind
    )
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'rowIndex', scoped.row_index,
        'actionKind', scoped.action_kind,
        'decision', coalesce(scoped.set_decision, (
          (scoped.eligibility - 'outcome' - 'validUntil'
            - 'eligiblePermissions' - 'reasonCode')
          || pg_catalog.jsonb_build_object(
            'recordId', scoped.record_id, 'action', scoped.declaration -> 'action'
          )
          || case
            when scoped.eligibility ->> 'outcome' = 'refused' then
              pg_catalog.jsonb_build_object(
                'outcome', 'refused', 'reasonCode', scoped.eligibility ->> 'reasonCode'
              )
            when not scoped.target_ok or pg_catalog.jsonb_array_length(scoped.matched) = 0 then
              pg_catalog.jsonb_build_object(
                'outcome', 'refused', 'reasonCode', 'record_scope_refused'
              )
            else pg_catalog.jsonb_build_object(
              'outcome', 'allowed',
              'validUntil', (
                select vortex_platform.format_timestamp_utc(
                  pg_catalog.min((match.value ->> 'validUntil')::timestamptz)
                )
                from pg_catalog.jsonb_array_elements(scoped.matched) as match(value)
              ),
              'matchedContributions', scoped.matched
            )
          end
        ))
      ) order by scoped.row_index,
        case scoped.action_kind when 'update' then 1
          when 'delete' then 2 else 3 end
    ), '[]'::jsonb)
    into decisions
    from scoped;
  return decisions;
end
$function$;

alter function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  owner to vortex_owner;

revoke all on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_access.evaluate_organization_record_access_page_internal(jsonb,jsonb,jsonb) is
  'Private page access decision over already validated read facts: shares eligibility by action declaration, decides every record whose routes have an exact set form in one set pass per declaration, and keeps the exact row-scope composition for every other record; a compact page row carries only its own record fact and shares the one page envelope''s facts, which are never copied per action job.';

create or replace function vortex_access.evaluate_record_access_with_validated_types_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb,
  p_eligibility jsonb,
  p_validated_record_types jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  record_types_invalid boolean;
  seen_relationship_ids text[] := array[]::text[];
  relationships_invalid boolean;
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Only the fixed record adapter can pass a type set validated earlier in
  -- this invocation. Request writable settings never authorize this shortcut.
  if p_validated_record_types is not null
    and p_validated_record_types = p_facts -> 'recordTypes' then
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value ->> 'recordTypeId')), array[]::text[])
    into seen_type_ids
    from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value);
  else
  -- Check the complete type and field set in one statement. Every row still
  -- receives the same shape, identity and duplicate checks; only the repeated
  -- PL/pgSQL-to-SQL call for each type and field is removed.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(record_type_item.value ->> 'recordTypeId')
      order by record_type_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(record_type_item.value) <> 'object'
      or not (record_type_item.value ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(record_type_item.value) = 'object'
            then record_type_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'storageContractId')
      or record_type_item.value ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item.value ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item.value ? 'ownershipRelationshipId') <>
        (record_type_item.value ->> 'ownershipMode' = 'inherited'))
      or (record_type_item.value ? 'ownershipRelationshipId'
        and not vortex_platform.is_non_nil_uuid(record_type_item.value ->> 'ownershipRelationshipId'))
      or (record_type_item.value ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item.value -> 'validationContractVersion') <> 'string'
        or record_type_item.value ->> 'validationContractVersion'
          <> all (vortex_definition.accepted_contract_version('record_type'))
      ))
      or pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') <> 'array'
      or fields.invalid
      or fields.duplicate_ids
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'))
  into seen_type_ids, record_types_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes')
    with ordinality as record_type_item(value, ordinality)
  cross join lateral (
    select coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(field_item.value) <> 'object'
      or not (field_item.value ?& array['fieldId', 'type'])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(field_item.value) = 'object'
            then field_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array['fieldId', 'type', 'settings'])
      )
      or not vortex_platform.is_non_nil_uuid(field_item.value ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_item.value -> 'type') <> 'string'
      or (field_item.value ? 'settings'
        and pg_catalog.jsonb_typeof(field_item.value -> 'settings') <> 'object')
    ), false) as invalid,
    pg_catalog.count(*) <> pg_catalog.count(distinct
      pg_catalog.lower(field_item.value ->> 'fieldId')) as duplicate_ids
    from pg_catalog.jsonb_array_elements(case
      when pg_catalog.jsonb_typeof(record_type_item.value -> 'fields') = 'array'
        then record_type_item.value -> 'fields' else '[]'::jsonb end
    ) as field_item(value)
  ) as fields;
  if record_types_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  end if;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every declared target: one for a link, several for a link to one of
  -- several record types. The whole set is checked in one statement, like the
  -- type set: every relationship receives the same shape, identity and
  -- duplicate checks without a PL/pgSQL round trip for each one.
  select coalesce(pg_catalog.array_agg(
      pg_catalog.lower(relationship_item.value ->> 'relationshipId')
      order by relationship_item.ordinality
    ), array[]::text[]),
    coalesce(pg_catalog.bool_or(
      pg_catalog.jsonb_typeof(relationship_item.value) <> 'object'
      or not (relationship_item.value ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(case
          when pg_catalog.jsonb_typeof(relationship_item.value) = 'object'
            then relationship_item.value else '{}'::jsonb end
        ) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromModuleRootId')
      or not vortex_platform.is_non_nil_uuid(relationship_item.value ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') is distinct from 'array'
      or pg_catalog.jsonb_array_length(case
        when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
          then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
      ) = 0
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(relationship_item.value -> 'toRecordTypes') = 'array'
            then relationship_item.value -> 'toRecordTypes' else '[]'::jsonb end
        ) as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(case
              when pg_catalog.jsonb_typeof(target.value) = 'object'
                then target.value else '{}'::jsonb end
            ) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
      )
    ), false)
      or pg_catalog.count(*) <> pg_catalog.count(distinct
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'))
  into seen_relationship_ids, relationships_invalid
  from pg_catalog.jsonb_array_elements(p_facts -> 'relationships')
    with ordinality as relationship_item(value, ordinality);
  if relationships_invalid then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_platform.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_platform.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_platform.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_platform.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  if p_eligibility is null then
    eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
      p_declaration, ctx, checked_at
    );
  else
    -- Only the fixed record adapter supplies eligibility it decided once for a
    -- page or a set of targets; a refusal is supplied as decided. The request
    -- role cannot execute this variant or supply a forged decision.
    eligibility := p_eligibility;
    if coalesce(eligibility ->> 'outcome', '') not in ('eligible', 'refused')
      or eligibility -> 'recordBinding' is distinct from p_declaration -> 'recordBinding'
      or eligibility -> 'target' is distinct from p_declaration -> 'target'
      or eligibility ->> 'organizationId' is distinct from ctx ->> 'organizationId'
      or eligibility ->> 'organizationAccountId' is distinct from ctx ->> 'organizationAccountId'
      or eligibility ->> 'accessVersion' is distinct from ctx ->> 'accessVersion'
      or eligibility ->> 'correlationId' is distinct from ctx ->> 'correlationId'
      or (eligibility ->> 'outcome' = 'eligible'
        and (eligibility ->> 'validUntil')::timestamptz <= checked_at) then
      raise exception using errcode = '22023', message = 'Supplied record eligibility is invalid';
    end if;
  end if;

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object(
      'recordId', p_target_record_id, 'action', p_declaration -> 'action',
      'checkedAt', pg_catalog.to_char(pg_catalog.timezone('UTC', checked_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at,
    vortex_access.effective_authentication_requirement_internal(
      (ctx ->> 'organizationId')::uuid, p_declaration -> 'recentAuthentication'
    )
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'relationship' then 3
        end,
        coalesce(contribution.value -> 'route' ->> 'sourceRecordId', '')
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select vortex_platform.format_timestamp_utc(
    pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

alter function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb)
  to vortex_record_adapter, postgres;
comment on function vortex_access.evaluate_record_access_with_validated_types_internal(jsonb,uuid,jsonb,jsonb,jsonb) is
  'Exact record access evaluation of one target, with eligibility computed here or supplied by the fixed record adapter (decided once per declaration for a set of targets or a page); validates each record fact set and composes each record scope independently.';

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
  context_value jsonb;
  requirement jsonb;
  acceptance record;
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
  context_value := vortex_access.validated_human_request_context();

  -- Preparing templates that confer a permission the application's accepted roles do not already
  -- hold is accepting them. The TypeScript builder authority (builderRecentAuthentication,
  -- roleAcceptanceAuthentication) asks for a recent primary sign-in and then a two-step
  -- verification within the hour; the same two are asked here, so a request that skips that
  -- check is refused the same way. The evaluator reads the organisation setting: with
  -- two-step verification turned off on a development instance the second requirement is a
  -- recent sign-in. A template list that cannot be read counts as conferring. Accepting never
  -- assigns a role, and the delegated-scope bound is enforced when a role is assigned.
  if p_change = 'prepare' and (
    pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates') is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates') = 'array'
          then p_prepared_templates -> 'templates' else '[]'::jsonb end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(item.value -> 'livePermissions') = 'array'
              then item.value -> 'livePermissions' else '[]'::jsonb end
          ) as candidate(value)
          -- A permission the role accepted from this template and still holds is not conferred anew.
          where not exists (
            select 1
            from vortex_access.organization_roles as role
            join vortex_access.organization_role_revisions as revision
              on revision.organization_id = role.organization_id
              and revision.role_id = role.role_id
              and revision.revision = role.live_revision
              and revision.lifecycle = 'active'
            join vortex_access.organization_role_permission_entries as permission
              on permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = revision.revision
            where role.organization_id = authority.organization_id
              and role.role_kind = 'application'
              and role.application_root_id = p_application_root_id
              and role.source_role_id::text = pg_catalog.lower(item.value #>> '{template,roleId}')
              and permission.application_root_id::text
                = pg_catalog.lower(candidate.value ->> 'applicationRootId')
              and permission.owner_kind = candidate.value ->> 'ownerKind'
              and permission.owner_id::text = pg_catalog.lower(candidate.value ->> 'ownerId')
              and permission.permission_id::text
                = pg_catalog.lower(candidate.value #>> '{permission,permissionId}')
          )
        )
    )
  ) then
    foreach requirement in array array[
      pg_catalog.jsonb_build_object('kind', 'primary', 'maximumAgeSeconds', 900),
      pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600)
    ] loop
      select evaluated.* into strict acceptance
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', 'platform.organization.application_role_templates.accept',
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', vortex_access.required_platform_permission(
            'platform.organization.applications.manage'
          ),
          'recentAuthentication', requirement,
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      if acceptance.outcome = 'refused' and acceptance.reason_code = 'authentication_unsatisfied' then
        raise exception using errcode = 'V3150',
          message = 'Accepting role templates needs a recent sign-in';
      end if;
      if acceptance.outcome = 'refused' and acceptance.reason_code = 'multi_factor_unsatisfied' then
        raise exception using errcode = 'V3152',
          message = 'Accepting role templates needs a recent two-step verification';
      end if;
      if acceptance.outcome is distinct from 'eligible'
        or acceptance.target_kind is distinct from 'organization'
        or acceptance.target_application_root_id is not null
        or acceptance.organization_id is distinct from authority.organization_id
        or acceptance.organization_account_id is distinct from authority.organization_account_id
        or acceptance.access_version is distinct from authority.access_version
        or acceptance.correlation_id is distinct from authority.correlation_id then
        raise exception using errcode = '42501',
          message = 'Application installation authority is unavailable';
      end if;
    end loop;
  end if;

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
          null, null, null, null, null, null, null,
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

revoke all on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) to vortex_request;

comment on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) is
  'Authority-checked Application permission registration change for installation; derives actor and correlation from validated human context, asks a recent sign-in and two-step verification when the prepared templates confer a permission its accepted roles do not already hold, and grants no access.';

alter function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) owner to vortex_owner;

grant execute on function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) to postgres;

create or replace function vortex_identity.initialize_organization_security_settings(
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization security settings initialization is invalid';
  end if;
  -- Every organisation starts with two-step verification required.
  insert into vortex_identity.organization_security_settings (
    organization_id, require_step_up, revision, changed_at, changed_by_account_id
  ) values (p_organization_id, true, 1, pg_catalog.statement_timestamp(), null)
  on conflict (organization_id) do nothing;
end
$function$;

comment on function vortex_identity.initialize_organization_security_settings(uuid) is
  'Creates the default organisation security settings row (two-step verification required); an existing row is kept. Called only by the organisation creation functions.';

revoke all on function vortex_identity.initialize_organization_security_settings(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_identity.initialize_organization_security_settings(p_organization_id uuid) owner to vortex_owner;

grant execute on function vortex_identity.initialize_organization_security_settings(p_organization_id uuid) to postgres;

create or replace function vortex_identity.provision_tenant(
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_short_name text,
  p_tenant_display_name text,
  p_organization_short_name text,
  p_organization_display_name text,
  p_tenant_steward_identity_id uuid,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text,
  p_storage_project text
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  root_organization_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  new_tenant_id uuid := pg_catalog.gen_random_uuid();
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_tenant_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_tenant_id uuid;
  replay_organization_id uuid;
  replay_assignment_id uuid;
  replay_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Tenant provisioning input is invalid';
  end if;

  -- The new tenant has no row to lock yet. This lock is limited to one trusted
  -- actor/cluster/duplicate tuple and exists only to converge simultaneous retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|provision_tenant|' ||
      p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'provision_tenant', p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );

  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select tenant.tenant_id into replay_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored."subjectIds");
    select organization.organization_id into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_tenant_id is null or replay_organization_id is null
      or replay_assignment_id is null or replay_account_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'provision_tenant'::text,
      replay_tenant_id, replay_organization_id, replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_account_id)],
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if p_storage_project is null or p_storage_project !~ '^[a-z0-9][a-z0-9-]{0,119}$' then
    raise exception using errcode = '22023', message = 'Storage destination is invalid';
  end if;
  insert into vortex_platform.storage_destination(singleton, project_ref)
  values (true, p_storage_project) on conflict (singleton) do nothing;
  if not exists (select 1 from vortex_platform.storage_destination where singleton and project_ref = p_storage_project) then
    raise exception using errcode = '55000', message = 'Storage destination differs from the provisioned project';
  end if;
  if vortex_identity.tenant_short_name_reserved(p_tenant_short_name) then
    raise exception using errcode = 'V3190', message = 'Tenant short name is reserved for a platform route';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  -- Reuse the organisation runtime settings language/time-zone validators for account preferences.
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  begin
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by,
      state_changed_at, revision
    ) values (
      new_tenant_id, p_tenant_short_name, p_tenant_display_name, 'active',
      operation_at, p_operator_actor_id, operation_at, 1
    );
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, new_tenant_id, null, p_organization_short_name,
      p_organization_display_name, 'active', operation_at,
      p_operator_actor_id, operation_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (p_tenant_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1),
    (p_organization_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1)
  on conflict on constraint identity_projections_pk do nothing;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id in (
      p_tenant_steward_identity_id, p_organization_steward_identity_id
    ) and projection.state = 'active'
  order by projection.identity_id
  for update;
  if (select pg_catalog.count(distinct projection.identity_id)
      from vortex_identity.identity_projections as projection
      where projection.identity_id in (
        p_tenant_steward_identity_id, p_organization_steward_identity_id
      ) and projection.state = 'active') <>
     (select pg_catalog.count(distinct identity_id)
      from (values (p_tenant_steward_identity_id),
                   (p_organization_steward_identity_id)) as nominated(identity_id)) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    operation_at, operation_at, operation_at, p_operator_actor_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.initialize_organization_security_settings(new_organization_id);
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_tenant_assignment_id, new_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select adopted.access_version into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, p_operator_actor_id,
    new_correlation_id
  ) as adopted;

  -- The first owner needs a real current Group for Group-owned records. Access
  -- owns both facts and their version; no application-specific permission is added.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, operation_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  -- The role revision check trigger is deferred. Validate it while the privileged
  -- boundary is still active so a runtime-role commit cannot bypass or fail its reads.
  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_tenant_id, 1::bigint),
    (new_organization_id, resulting_access_version),
    (new_tenant_assignment_id, 1::bigint),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );

  return query select 'accepted'::text, 'provision_tenant'::text,
    new_tenant_id, new_organization_id, new_tenant_assignment_id, 1::bigint,
    new_account_id, 1::bigint, resulting_access_version,
    new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) to vortex_runtime;
comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations and an initial current owner Group membership for the organisation steward.';

alter function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) owner to vortex_owner;

grant execute on function vortex_identity.provision_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_short_name text, p_tenant_display_name text, p_organization_short_name text, p_organization_display_name text, p_tenant_steward_identity_id uuid, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text, p_storage_project text) to postgres;

create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_parent_organization_id uuid,
  p_organization_short_name text,
  p_organization_display_name text,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  stored record;
  claimed jsonb;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_organization_id uuid;
  replay_account_id uuid;
  required_projection_count bigint;
  active_projection_count bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_steward_identity_id::text)
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_display_name is null
    or p_organization_display_name is distinct from pg_catalog.btrim(p_organization_display_name)
    or pg_catalog.char_length(p_organization_display_name) not between 1 and 120
    or p_account_display_name is null
    or p_account_display_name is distinct from pg_catalog.btrim(p_account_display_name)
    or pg_catalog.char_length(p_account_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation creation command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  -- Tenant serialization converges duplicate and short-name races and keeps a
  -- parent lifecycle change from crossing this creation decision.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Identity lifecycle writers use the same projection rows. Lock caller and
  -- nominee in stable order, but defer eligibility checks until after replay.
  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
  order by projection.identity_id
  for share;

  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );
  if vortex_access.recent_authentication_deadline_internal(
    vortex_platform.current_context(), evaluated_at,
    '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
  ) is null then
    raise exception using errcode = 'V3152',
      message = 'Tenant governance requires multi-factor authentication';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]
    );
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_account_id)
      ],
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_organization_id)
      ],
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );


  select pg_catalog.count(distinct nominated.identity_id)
  into required_projection_count
  from (values
    (actor_identity_id),
    (p_organization_steward_identity_id)
  ) as nominated(identity_id);
  select pg_catalog.count(distinct projection.identity_id)
  into active_projection_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
    and projection.state = 'active';
  if active_projection_count <> required_projection_count then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if p_parent_organization_id is not null
    and not exists (
      select 1
      from vortex_identity.organizations as parent
      where parent.tenant_id = p_tenant_id
        and parent.organization_id = p_parent_organization_id
        and parent.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Re-evaluate after all locks on existing facts. No creator membership or
  -- projection fallback is inferred from the tenant assignment.
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  begin
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, p_tenant_id, p_parent_organization_id,
      p_organization_short_name, p_organization_display_name, 'active',
      evaluated_at, actor_identity_id, evaluated_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    evaluated_at, evaluated_at, evaluated_at, actor_identity_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.initialize_organization_security_settings(new_organization_id);
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, actor_identity_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, actor_identity_id, new_correlation_id
  );

  select adopted.access_version
  into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, actor_identity_id,
    new_correlation_id
  ) as adopted;

  -- The initial steward has one current Group for Group-owned records.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, evaluated_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  set constraints
    vortex_access.organization_role_revisions_checked
    immediate;
  set constraints
    vortex_access.organization_role_revisions_checked
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions)
    )
  );

  return query
  select 'accepted'::text,
    'create_tenant_organization'::text,
    new_organization_id,
    1::bigint,
    new_account_id,
    1::bigint,
    resulting_access_version,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) owner to vortex_owner;

grant execute on function vortex_identity.create_tenant_organization(p_duplicate_key uuid, p_tenant_id uuid, p_parent_organization_id uuid, p_organization_short_name text, p_organization_display_name text, p_organization_steward_identity_id uuid, p_account_display_name text, p_account_language text, p_account_time_zone text, p_runtime_language text, p_runtime_time_zone text, p_runtime_currency text, p_runtime_date_format text, p_runtime_number_format text) to postgres;

create or replace function vortex_access.read_current_organization_step_up_setting()
returns table (
  require_step_up boolean,
  revision bigint,
  changed_at timestamptz,
  changed_by_display_name text,
  can_change boolean,
  can_turn_off boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  stored vortex_identity.organization_security_settings%rowtype;
  decision record;
  change_permitted boolean;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_value := (context_value ->> 'organizationId')::uuid;

  select setting.* into stored
  from vortex_identity.organization_security_settings as setting
  where setting.organization_id = organization_value;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Organization security settings are unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.step_up_setting.change',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.assignments.manage'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  change_permitted := decision.outcome = 'eligible'
    and decision.organization_id is not distinct from organization_value;

  return query select
    -- What a two-step check in this organisation answers now, from the one mapper, so the
    -- reading can never disagree with the check.
    (vortex_access.effective_authentication_requirement_internal(
      organization_value,
      pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600)
    ) ->> 'kind') = 'multi_factor',
    case when change_permitted then stored.revision else null end,
    case when change_permitted then stored.changed_at else null end,
    case when change_permitted then (
      select account.display_name
      from vortex_identity.organization_accounts as account
      where account.organization_id = organization_value
        and account.organization_account_id = stored.changed_by_account_id
    ) else null end,
    change_permitted,
    change_permitted and exists (
      select 1 from vortex_platform.instance_profile as profile
      where profile.kind = 'development'
    );
end
$function$;

comment on function vortex_access.read_current_organization_step_up_setting() is
  'Reads the two-step setting of the validated human organisation context. Every member sees whether two-step verification is required; the revision, the last change and who may change or turn it off are returned only to a holder of the organisation access-assignment permission.';

revoke all on function vortex_access.read_current_organization_step_up_setting()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.read_current_organization_step_up_setting()
  to vortex_request;

alter function vortex_access.read_current_organization_step_up_setting() owner to vortex_owner;

grant execute on function vortex_access.read_current_organization_step_up_setting() to postgres;

create or replace function vortex_access.change_current_organization_step_up_setting(
  p_expected_revision bigint,
  p_require_step_up boolean,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  stored vortex_identity.organization_security_settings%rowtype;
  decision record;
  requirement jsonb;
  step integer;
  has_second_factor boolean;
  refusal_reason text;
  action_key text := case when p_require_step_up then 'turn_step_up_on' else 'turn_step_up_off' end;
  now_value timestamptz := pg_catalog.statement_timestamp();
  activity_result text;
  new_revision bigint;
  next_access_version bigint;
begin
  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or p_require_step_up is null
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization step-up setting input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  -- The trusted entry point states whether the person has a verified second factor. A missing
  -- fact means the person is treated as enrolled, so the code is required.
  has_second_factor := case
    when pg_catalog.jsonb_typeof(context_value -> 'hasSecondFactor') = 'boolean'
      then (context_value ->> 'hasSecondFactor')::boolean
    else true
  end;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization security administration is unavailable';
  end if;

  -- Step 1: the sign-in of the change itself (900 seconds, the builder constant). Step 2, only for
  -- turning the requirement off by a person with a verified second factor: the current code,
  -- evaluated through the mapper like every other two-step check.
  for step in 1..2 loop
    if step = 2 then
      exit when p_require_step_up;
      if not exists (
        select 1 from vortex_platform.instance_profile as profile
        where profile.kind = 'development'
      ) then
        -- Off a development instance the answer is a refusal that keeps its Activity entry.
        activity_result := vortex_record.append_organization_activity_entry(
          context_organization_id, p_activity_id, now_value,
          'organization_account', context_account_id, action_key,
          array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
          context_correlation_id, 'refused'
        );
        if activity_result is distinct from 'inserted' then
          raise exception using errcode = '40001',
            message = 'Organization step-up setting refusal Activity is stale';
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'refusalReason', 'development_instance_required',
          'accessVersion', context_access_version
        );
      end if;
      exit when not has_second_factor;
      requirement := pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600);
    else
      requirement := pg_catalog.jsonb_build_object('kind', 'primary', 'maximumAgeSeconds', 900);
    end if;

    select evaluated.* into strict decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.step_up_setting.change',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', vortex_access.required_platform_permission(
          'platform.organization.assignments.manage'
        ),
        'recentAuthentication', requirement,
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    if decision.operation_key is distinct from 'platform.organization.step_up_setting.change'
      or decision.target_kind is distinct from 'organization'
      or decision.target_application_root_id is not null
      or decision.organization_id is distinct from context_organization_id
      or decision.organization_account_id is distinct from context_account_id
      or decision.access_version is distinct from context_access_version
      or decision.correlation_id is distinct from context_correlation_id then
      raise exception using errcode = '42501',
        message = 'Organization security administration is unavailable';
    end if;
    if decision.outcome = 'refused'
      and decision.reason_code in ('authentication_unsatisfied', 'multi_factor_unsatisfied') then
      refusal_reason := case decision.reason_code
        when 'authentication_unsatisfied' then 'recent_authentication_required'
        else 'multi_factor_required'
      end;
      -- A refused change keeps its Activity entry, so it is returned, never raised.
      activity_result := vortex_record.append_organization_activity_entry(
        context_organization_id, p_activity_id, decision.checked_at,
        'organization_account', context_account_id, action_key,
        array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
        context_correlation_id, 'refused'
      );
      if activity_result is distinct from 'inserted' then
        raise exception using errcode = '40001',
          message = 'Organization step-up setting refusal Activity is stale';
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'refusalReason', refusal_reason,
        'accessVersion', context_access_version
      );
    end if;
    if decision.outcome is distinct from 'eligible' then
      raise exception using errcode = '42501',
        message = 'Organization security administration is unavailable';
    end if;
  end loop;

  select setting.* into stored
  from vortex_identity.organization_security_settings as setting
  where setting.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Organization security settings are unavailable';
  end if;
  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'revision', stored.revision,
      'requireStepUp', stored.require_step_up, 'accessVersion', context_access_version
    );
  end if;
  if stored.require_step_up = p_require_step_up then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unchanged', 'revision', stored.revision,
      'requireStepUp', stored.require_step_up,
      'accessVersion', context_access_version
    );
  end if;

  new_revision := stored.revision + 1;
  update vortex_identity.organization_security_settings as setting
  set require_step_up = p_require_step_up, revision = new_revision, changed_at = now_value,
    changed_by_account_id = context_account_id
  where setting.organization_id = context_organization_id;

  -- Contexts and decisions made under the old setting must not outlive it.
  select version.current_version into strict next_access_version
  from vortex_access.increment_organization_access_version(
    context_organization_id, context_account_id, context_correlation_id,
    'authentication_requirement_changed'
  ) as version;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value,
    'organization_account', context_account_id, action_key,
    array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization step-up setting Activity is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'saved', 'revision', new_revision, 'requireStepUp', p_require_step_up,
    'accessVersion', next_access_version
  );
end
$function$;

comment on function vortex_access.change_current_organization_step_up_setting(bigint, boolean, uuid) is
  'Changes the two-step setting of the validated human organisation context (no organisation argument). Needs the organisation access-assignment permission and a recent sign-in; turning it off also needs a development instance and, for a person with a verified second factor, the current code. A stale sign-in or code returns a refused outcome with a refused Activity entry; a missing permission raises. Every real change advances the Access version.';

revoke all on function vortex_access.change_current_organization_step_up_setting(bigint, boolean, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.change_current_organization_step_up_setting(bigint, boolean, uuid)
  to vortex_request;

alter function vortex_access.change_current_organization_step_up_setting(p_expected_revision bigint, p_require_step_up boolean, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.change_current_organization_step_up_setting(p_expected_revision bigint, p_require_step_up boolean, p_activity_id uuid) to postgres;

reset role;
