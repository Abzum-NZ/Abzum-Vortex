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
        raise exception using errcode = '42501',
          message = 'Two-step verification can be turned off only on a development instance';
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
      'requireStepUp', stored.require_step_up
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
