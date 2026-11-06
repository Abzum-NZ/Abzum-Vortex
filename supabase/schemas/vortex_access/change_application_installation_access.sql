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
