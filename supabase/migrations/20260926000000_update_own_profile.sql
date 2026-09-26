-- #1023: one protected operation lets a person change their own display name, language and time
-- zone, or change another active organisation account's profile with
-- platform.organization.accounts.manage.
--
-- Identity owns the private account-profile writer; Access owns the protected request entry. The
-- actor, organisation and account come only from the validated human request context, never from
-- the command. Access takes the organisation Access-version lock (active organisation and tenant,
-- unchanged Access version) before it authorises; the permission-free own-account path is refused
-- in a delegated or support context. The account revision is exact, and Access version is never
-- changed because a profile edit is not an authorisation change. Both refusal and completion append one content-free Activity through
-- vortex_context.channel().

create or replace function vortex_identity.update_organization_account_profile_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text
)
returns table (
  organization_id uuid,
  organization_account_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_accounts%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120
    or (p_language is not null
      and (p_language <> pg_catalog.btrim(p_language)
        or pg_catalog.char_length(p_language) not between 2 and 35))
    or (p_time_zone is not null
      and (p_time_zone <> pg_catalog.btrim(p_time_zone)
        or pg_catalog.char_length(p_time_zone) not between 1 and 100)) then
    raise exception using errcode = '22023',
      message = 'Organization account profile update is invalid';
  end if;

  select account.* into existing
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found
    or existing.state <> 'active'
    or existing.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001',
      message = 'Organization account profile update is stale or unavailable';
  end if;
  if existing.display_name is not distinct from p_display_name
    and existing.language is not distinct from p_language
    and existing.time_zone is not distinct from p_time_zone then
    raise exception using errcode = '40001',
      message = 'Organization account profile is unchanged';
  end if;

  update vortex_identity.organization_accounts as account
  set display_name = p_display_name,
      language = p_language,
      time_zone = p_time_zone,
      changed_at = pg_catalog.statement_timestamp(),
      revision = account.revision + 1
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  returning * into existing;

  return query select existing.organization_id, existing.organization_account_id,
    existing.display_name, existing.state, existing.language, existing.time_zone,
    existing.changed_at, existing.revision;
end
$function$;

revoke all on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

comment on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) is
  'Owner-only Identity writer for one active organisation account profile under an exact current revision; changes display name, language and time zone only and advances the account revision.';

create or replace function vortex_access.update_own_profile(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_account_id uuid,
  account_summary jsonb,
  correlation_id uuid,
  accepted_at timestamptz,
  access_version bigint
)
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
  decision record;
  changed record;
  activity_result text;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account profile command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

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
      message = 'Organization account profile update is unavailable';
  end if;

  if p_organization_account_id = context_account_id then
    -- The own-account path needs no permission, so it is only for the person themself: a
    -- delegated or support context acting for them is refused like any unavailable change.
    if context_value ? 'delegatedContext' or context_value ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  else
    select evaluated.* into strict decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.accounts.update_profile',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '630a980c-0ff5-40b1-a329-7326a2122395'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    if decision.outcome = 'refused'
      and decision.operation_key = 'platform.organization.accounts.update_profile'
      and decision.target_kind = 'organization'
      and decision.target_application_root_id is null
      and decision.organization_id = context_organization_id
      and decision.organization_account_id = context_account_id
      and decision.access_version = context_access_version
      and decision.correlation_id = context_correlation_id
      and decision.reason_code in (
        'permission_unavailable', 'permission_not_effective',
        'authentication_unsatisfied', 'delegation_insufficient'
      ) then
      activity_result := vortex_activity.append_organization_activity_entry(
        context_organization_id, p_activity_id, decision.checked_at,
        'organization_account', context_account_id, 'update_organization_account_profile',
        array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_context.channel(),
        context_correlation_id, 'refused'
      );
      if activity_result is distinct from 'inserted' then
        raise exception using errcode = '40001',
          message = 'Organization account profile refusal Activity is stale';
      end if;
      return query select 'refused'::text, 'update_own_profile'::text,
        context_organization_id, p_organization_account_id, null::jsonb,
        context_correlation_id, decision.checked_at, context_access_version;
      return;
    end if;

    if decision.outcome is distinct from 'eligible'
      or decision.operation_key is distinct from
        'platform.organization.accounts.update_profile'
      or decision.target_kind is distinct from 'organization'
      or decision.target_application_root_id is not null
      or decision.organization_id is distinct from context_organization_id
      or decision.organization_account_id is distinct from context_account_id
      or decision.access_version is distinct from context_access_version
      or decision.correlation_id is distinct from context_correlation_id then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  end if;

  select updated.* into strict changed
  from vortex_identity.update_organization_account_profile_internal(
    context_organization_id, p_organization_account_id, p_expected_revision,
    p_display_name, p_language, p_time_zone
  ) as updated;
  if changed.organization_id is distinct from context_organization_id
    or changed.organization_account_id is distinct from p_organization_account_id
    or changed.revision is distinct from p_expected_revision + 1 then
    raise exception using errcode = '42501',
      message = 'Organization account profile result is unavailable';
  end if;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'update_organization_account_profile',
    array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization account profile Activity is stale';
  end if;

  return query select 'accepted'::text, 'update_own_profile'::text,
    context_organization_id, p_organization_account_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationAccountId', changed.organization_account_id,
      'displayName', changed.display_name,
      'state', changed.state,
      'language', changed.language,
      'timeZone', changed.time_zone,
      'revision', changed.revision
    )),
    context_correlation_id, changed.changed_at, context_access_version;
end
$function$;

revoke all on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) to vortex_request;

comment on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) is
  'Protected profile update for one active organisation account: a person may change their own display name, language and time zone, and may change another account only with platform.organization.accounts.manage. The actor and organisation come only from the validated request context; the account revision is exact and Access version is never changed.';
