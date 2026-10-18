set local role vortex_owner;

create or replace function vortex_access.read_organization_role_change_evidence_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  has_administrative_permissions boolean;
  target_application_root_id uuid;
  target_source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  live_permissions jsonb;
  template_source jsonb;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  role_configuration jsonb;
  target_role_id uuid;
  expected_role_revision bigint;
  target_lifecycle text := 'active';
  authority_broadened boolean := false;
  manifest_required boolean := false;
  affected_assignments jsonb;
begin
  -- New-role callers supply bounded configuration only. Existing-Application-revision callers
  -- supply only the selected role identity and expected revision; this function derives that
  -- role's configuration and application source from the verified organisation's stored rows.
  -- Neither path accepts a fingerprint or organisation from its caller.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in (
      'create_custom', 'accept_new_application_role', 'accept_application_role_revision'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';

  if operation_name = 'accept_application_role_revision' then
    if p_preparation - array[
      'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
    ]::text[] <> '{}'::jsonb
      or not (p_preparation ?& array[
        'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
      ])
      or pg_catalog.jsonb_typeof(p_preparation -> 'roleId') is distinct from 'string'
      or vortex_platform.is_non_nil_uuid(p_preparation ->> 'roleId') is not true
      or (p_preparation ->> 'roleId') <> (p_preparation ->> 'roleId')::uuid::text
      or pg_catalog.jsonb_typeof(p_preparation -> 'expectedRoleRevision')
        is distinct from 'number'
      or (p_preparation ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (p_preparation ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((p_preparation ->> 'expectedRoleRevision')::numeric)
      or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority')
        is distinct from 'string'
      or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  elsif pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current role-management authority decide the
  -- organisation; the caller never names it.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'accept_application_role_revision' then
    target_role_id := (p_preparation ->> 'roleId')::uuid;
    expected_role_revision :=
      (p_preparation ->> 'expectedRoleRevision')::numeric::bigint;
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = context_organization_id
      and stored.role_id = target_role_id;
    if not found
      or role_identity.role_kind <> 'application'
      or role_identity.application_root_id is null
      or role_identity.application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.source_role_id is null
      or role_identity.source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.live_revision <> expected_role_revision then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if role_identity.live_revision = 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = expected_role_revision;
    if not found
      or current_revision.lifecycle is null
      or current_revision.lifecycle not in ('active', 'acceptance_required') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
    role_configuration := pg_catalog.jsonb_build_object(
      'roleId', role_identity.role_id,
      'expectedRoleRevision', current_revision.revision,
      'key', current_revision.role_key,
      'label', current_revision.label,
      'description', current_revision.description,
      'privilegeClassification', current_revision.privilege_classification,
      'assignmentPolicy', case current_revision.assignment_policy
        when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
        else pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', current_revision.activation_policy_id,
              'revision', current_revision.activation_policy_revision
            )
          )
        )
      end,
      'sourceRoleId', role_identity.source_role_id
    );
  end if;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if operation_name <> 'accept_application_role_revision' then
      if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
        or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
        raise exception using errcode = '22023',
          message = 'Organization role-change preparation input is invalid';
      end if;
      target_application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
      target_source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;
    end if;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- The writer reads the same projection, so the evidence names the registration revision and
    -- its catalogue fingerprint instead of carrying the registered entries.
    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      context_organization_id, target_application_root_id, application_registration.revision,
      target_source_role_id
    );
    if live_permissions is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    template_source := pg_catalog.jsonb_build_object(
      'applicationRootId', target_application_root_id,
      'registrationRevision', application_registration.revision,
      'catalogueFingerprint', application_registration.permission_catalogue_fingerprint
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value ->> 'permissionId'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', continuity.meaning_fingerprint
    )) order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id),
    pg_catalog.bool_or(catalogue.administrative)
  into permissions_value, has_administrative_permissions
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_scope_id = coalesce(case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (requested_permission.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = continuity.organization_id
    and catalogue.registration_kind = continuity.registration_kind
    and catalogue.registration_owner_id = continuity.registration_owner_id
    and catalogue.registration_revision = registration.revision
    and catalogue.owner_kind = continuity.owner_kind
    and catalogue.owner_id = continuity.owner_id
    and catalogue.permission_id = continuity.permission_id
    and catalogue.application_root_id is not distinct from continuity.application_root_id
    and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  -- Reject the submitted classification before sealing evidence for a write whose deferred
  -- revision constraint would reject the same administrative permissions at commit.
  if operation_name <> 'accept_application_role_revision'
    and p_preparation ->> 'privilegeClassification' = 'standard'
    and has_administrative_permissions then
    return pg_catalog.jsonb_build_object(
      'outcome', 'invalid_privilege_classification',
      'organizationId', context_organization_id
    );
  end if;

  if operation_name = 'accept_application_role_revision' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as proposed(value)
      where not exists (
        select 1
        from vortex_access.organization_role_permission_entries as existing
        where existing.organization_id = context_organization_id
          and existing.role_id = target_role_id
          and existing.role_revision = current_revision.revision
          and existing.application_root_id is not distinct from
            case when proposed.value ? 'applicationRootId'
              then (proposed.value ->> 'applicationRootId')::uuid else null end
          and existing.owner_kind = proposed.value ->> 'ownerKind'
          and existing.owner_id = (proposed.value ->> 'ownerId')::uuid
          and existing.permission_id = (proposed.value ->> 'permissionId')::uuid
          and existing.continuity_revision =
            (proposed.value ->> 'continuityRevision')::numeric::bigint
          and existing.meaning_fingerprint = proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    -- The candidate preserves the current assignment policy and either moves from
    -- acceptance_required to active or keeps an active revision active. This is the writer's
    -- manifest predicate, so the only additional true term for this operation is a broadened
    -- permission projection.
    manifest_required :=
      current_revision.assignment_policy is distinct from
        (role_configuration #>> '{assignmentPolicy,kind}')
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if manifest_required then
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleAssignmentId', assignment.role_assignment_id,
            'expectedRevision', assignment.revision,
            'assignee', case
              when assignment.assignee_kind = 'organization_account' then
                pg_catalog.jsonb_build_object(
                  'kind', 'organization_account',
                  'organizationAccountId', assignment.organization_account_id
                )
              else pg_catalog.jsonb_build_object(
                'kind', 'group',
                'groupId', assignment.group_id
              )
            end
          ) order by assignment.role_assignment_id
        ),
        '[]'::jsonb
      ) into affected_assignments
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = target_role_id
        and assignment.state = 'live';
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'roleConfiguration', role_configuration,
      'permissions', permissions_value,
      'templateContinuityRevision', selected_continuity.continuity_revision,
      'templateSource', template_source,
      'manifestRequired', manifest_required,
      'affectedAssignments', affected_assignments
    );
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'templateSource', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'templateSource', template_source
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

revoke execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb) is
  'Server-side preparation read: given bounded role configuration or an existing Application role identity and expected revision, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, deriving stored role configuration, actor and organisation from protected context and including an exact live-assignment snapshot only when the writer requires it.';

alter function vortex_access.read_organization_role_change_evidence_for_administration(p_preparation jsonb) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_change_evidence_for_administration(p_preparation jsonb) to postgres;

reset role;
