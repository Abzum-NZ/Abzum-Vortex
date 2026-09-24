-- #918: protected setter for the organisation's default application.
--
-- #599 added storage and the request-role read for the exact organisation
-- default application reference (a nullable installed-application root on the
-- Identity-owned runtime-settings row). This migration adds the missing
-- protected write side:
--
-- 1. vortex_identity.update_organization_default_application_internal: the
--    private Identity writer that locks the settings row, applies the exact
--    expected-revision check and either changes the reference or reports the
--    value as already current.
-- 2. vortex_access.set_organization_default_application_for_administration:
--    the protected Access operation. It requires the fixed
--    runtime-settings.manage permission and the current request context,
--    accepts only the exact active installed application registration of the
--    context organisation (or null to clear), appends content-free Activity
--    evidence for a real change and derives everything else from the validated
--    human context.
--
-- Marking a default grants nobody access; the read path still filters the
-- configured default through current page authority and falls back to the
-- launcher for a withdrawn application.

create function vortex_identity.update_organization_default_application_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_default_application_root_id uuid
)
returns table (
  organization_id uuid,
  previous_default_application_root_id uuid,
  default_application_root_id uuid,
  revision bigint,
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  previous_id uuid;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or (p_default_application_root_id is not null
      and p_default_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Organization default application update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization default application is stale or unavailable';
  end if;

  previous_id := existing.default_application_root_id;

  -- Re-submitting the current value is not a change: report it unchanged so no
  -- Activity is written and the revision is not advanced.
  if previous_id is not distinct from p_default_application_root_id then
    return query select existing.organization_id, previous_id, previous_id,
      existing.revision, false;
    return;
  end if;

  update vortex_identity.organization_runtime_settings as settings
  set default_application_root_id = p_default_application_root_id,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, previous_id,
    existing.default_application_root_id, existing.revision, true;
end
$function$;

revoke all on function vortex_identity.update_organization_default_application_internal(
  uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
comment on function vortex_identity.update_organization_default_application_internal(
  uuid, bigint, uuid
) is
  'Private Identity writer for the exact organisation default application reference; requires the current settings revision and reports an unchanged value without advancing it.';

create function vortex_access.set_organization_default_application_for_administration(
  p_default_application_root_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  organization_id uuid,
  default_application_root_id uuid,
  revision bigint,
  changed boolean
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
  decision record;
  outcome_row record;
  activity_subject uuid;
  append_result text;
begin
  if (p_default_application_root_id is not null
      and p_default_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization default application update is invalid';
  end if;

  -- Establish the request identity, then take the same organisation
  -- Access-version lock used by the runtime-settings update and revalidate while
  -- it is held, so a revocation that committed while this operation waited
  -- cannot reach permission evaluation or the settings write.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization default application update is unavailable';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.default_application.set',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.default_application.set'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization default application update is unavailable';
  end if;

  -- Only an exact active installed application of this same organisation may be
  -- selected: an active application registration whose owner root is an
  -- application of the context organisation, still bound to its exact
  -- application release, with an active installation binding for that release.
  -- This is the same installed-application set the organisation address reads
  -- (20260924250000_application_address_resolution.sql).
  if p_default_application_root_id is not null then
    if not exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = context_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_default_application_root_id
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_definition.releases as release
          where release.root_id = root.root_id
            and release.release_revision = registration.source_revision
            and release.content_fingerprint = registration.source_content_fingerprint
            and release.resolution_fingerprint = registration.source_resolution_fingerprint
            and release.compilation_output ->> 'kind' = 'application'
        )
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = context_organization_id
            and binding.application_root_id = p_default_application_root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    ) then
      raise exception using errcode = '42501',
        message = 'Organization default application update is unavailable';
    end if;
  end if;

  select updated.* into strict outcome_row
  from vortex_identity.update_organization_default_application_internal(
    context_organization_id, p_expected_revision, p_default_application_root_id
  ) as updated;

  if outcome_row.organization_id is distinct from context_organization_id
    or (outcome_row.changed and outcome_row.revision <> p_expected_revision + 1)
    or (not outcome_row.changed and outcome_row.revision <> p_expected_revision)
    or outcome_row.default_application_root_id is distinct from p_default_application_root_id then
    raise exception using errcode = '55000',
      message = 'Organization default application result is inconsistent';
  end if;

  if outcome_row.changed then
    -- A change records content-free Activity evidence. The subject is the
    -- application being made the default, or the application being cleared.
    activity_subject := coalesce(
      outcome_row.default_application_root_id, outcome_row.previous_default_application_root_id
    );
    if activity_subject is null then
      raise exception using errcode = '55000',
        message = 'Organization default application evidence is inconsistent';
    end if;
    append_result := vortex_activity.append_organization_activity_entry(
      context_organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      context_account_id,
      case
        when outcome_row.default_application_root_id is null
          then 'clear_organization_default_application'
        else 'set_organization_default_application'
      end,
      array[activity_subject]::uuid[],
      array[]::uuid[],
      'web',
      context_correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization default application Activity is stale';
    end if;
  end if;

  return query select outcome_row.organization_id, outcome_row.default_application_root_id,
    outcome_row.revision, outcome_row.changed;
end
$function$;

revoke all on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) to vortex_request;
comment on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) is
  'Fixed protected organisation default-application setter requiring runtime-settings.manage and an exact current revision; accepts only an exact active installed application of the context organisation, or null to clear, and appends content-free Activity for the change.';
