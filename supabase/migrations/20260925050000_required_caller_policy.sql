-- #1053: replace the built-in "independent approval required" flag on role activation policies
-- with an optional required caller: the one published flow execution binding (#685) that is the
-- only permitted way to activate the role. Approvals are backend workflows, so core keeps no
-- approval field. The activation operation checks the invoking binding's own run-as actor, never
-- the responder, and a policy change stays a protected role-change operation.

begin;

alter table vortex_access.organization_role_activation_policy_revisions
  add column required_caller_execution_binding_id uuid;

alter table vortex_access.organization_role_activation_policy_revisions
  add constraint organization_role_activation_policy_revisions_required_caller_valid
  check (
    required_caller_execution_binding_id is null
    or required_caller_execution_binding_id <> '00000000-0000-0000-0000-000000000000'::uuid
  );

alter table vortex_access.organization_role_activation_policy_revisions
  drop column independent_approval_required;

-- A signature change is an explicit drop, then a create; the new signature is owner-only again.
drop function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid
);

create or replace function vortex_access.coordinate_role_change_without_stewardship_v1_internal(
  p_evidence jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  candidate jsonb;
  operation_name text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_role_key text;
  target_label text;
  target_description text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_activation_policy_fingerprint text;
  target_application_root_id uuid;
  target_source_role_id uuid;
  target_source_definition_key text;
  target_source_release_revision bigint;
  target_source_release_version text;
  target_source_validation_contract_version text;
  target_source_content_fingerprint text;
  target_source_resolution_fingerprint text;
  target_source_template_fingerprint text;
  target_source_catalogue_fingerprint text;
  target_accepted_registration_revision bigint;
  target_template_continuity_revision bigint;
  target_accepted_grant_fingerprint text;
  target_role_revision bigint;
  candidate_permissions jsonb;
  canonical_permissions jsonb;
  current_permissions jsonb;
  permission_count bigint;
  prepared_templates jsonb;
  selected_template jsonb;
  selected_template_count bigint;
  policy_choice jsonb;
  policy_value jsonb;
  policy_reference jsonb;
  supplied_new_policy_fingerprint text;
  supplied_accepted_grant_fingerprint text;
  supplied_role_candidate_fingerprint text;
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  maximum_policy_revision bigint;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
  policy_result jsonb;
begin
  if p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array[
      'contractVersion', 'candidate', 'newActivationPolicyFingerprint',
      'acceptedGrantFingerprint', 'roleCandidateFingerprint',
      'affectedAssignmentManifest'
    ]::text[] <> '{}'::jsonb
    or not (p_evidence ?& array[
      'contractVersion', 'candidate', 'roleCandidateFingerprint'
    ])
    or p_evidence ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_evidence -> 'candidate') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_evidence -> 'roleCandidateFingerprint')
      is distinct from 'string'
    or p_evidence ->> 'roleCandidateFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    or (p_evidence ? 'newActivationPolicyFingerprint' and (
      pg_catalog.jsonb_typeof(p_evidence -> 'newActivationPolicyFingerprint')
        is distinct from 'string'
      or p_evidence ->> 'newActivationPolicyFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    ))
    or (p_evidence ? 'acceptedGrantFingerprint' and (
      pg_catalog.jsonb_typeof(p_evidence -> 'acceptedGrantFingerprint')
        is distinct from 'string'
      or p_evidence ->> 'acceptedGrantFingerprint' !~ '^sha256:[a-f0-9]{64}$'
    ))
    or (p_evidence ? 'affectedAssignmentManifest' and
      pg_catalog.jsonb_typeof(p_evidence -> 'affectedAssignmentManifest')
        is distinct from 'object')
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
  end if;

  candidate := p_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision',
    'retire_role'
  ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change operation is invalid';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'operation') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string' then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;
  if target_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate ->> 'organizationId' <> target_organization_id::text
    or candidate ->> 'roleId' <> target_role_id::text then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if candidate ? 'expectedRoleRevision' then
      raise exception using errcode = '22023',
        message = 'A role creation cannot carry an expected revision';
    end if;
  elsif pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
      is distinct from 'number'
    or (candidate ->> 'expectedRoleRevision')::numeric < 1
    or (candidate ->> 'expectedRoleRevision')::numeric > 9007199254740991
    or (candidate ->> 'expectedRoleRevision')::numeric <>
      pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Expected role revision is invalid';
  else
    expected_role_revision := (candidate ->> 'expectedRoleRevision')::numeric::bigint;
  end if;

  if operation_name = 'retire_role' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
    ]::text[] <> '{}'::jsonb
      or not (candidate ?& array[
        'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
      ]) then
      raise exception using errcode = '22023',
        message = 'Role retirement shape is invalid';
    end if;
  else
    if not (candidate ?& array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'assignmentPolicy')
        is distinct from 'object'
      or pg_catalog.char_length(candidate ->> 'key') not between 1 and 40
      or candidate ->> 'key' !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or candidate ->> 'label' <> pg_catalog.btrim(candidate ->> 'label')
      or pg_catalog.char_length(candidate ->> 'label') not between 1 and 60
      or candidate ->> 'description' <> pg_catalog.btrim(candidate ->> 'description')
      or pg_catalog.char_length(candidate ->> 'description') not between 1 and 1000
      or candidate ->> 'privilegeClassification' not in ('standard', 'privileged') then
      raise exception using errcode = '22023',
        message = 'Role configuration shape is invalid';
    end if;
    target_role_key := candidate ->> 'key';
    target_label := candidate ->> 'label';
    target_description := candidate ->> 'description';
    target_privilege_classification := candidate ->> 'privilegeClassification';
  end if;

  if operation_name in (
    'create_custom', 'revise_custom_permissions', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  ) then
    if pg_catalog.jsonb_typeof(candidate -> 'permissions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'permissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Role permission evidence is invalid';
    end if;
    candidate_permissions := candidate -> 'permissions';
  elsif candidate ? 'permissions' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry permissions';
  end if;

  if operation_name in (
    'create_custom_from_template', 'accept_new_application_role',
    'accept_application_role_revision'
  ) then
    if not (candidate ?& array[
      'preparedTemplates', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'preparedTemplates') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate -> 'sourceRoleId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'templateContinuityRevision')
        is distinct from 'number'
      or (candidate ->> 'templateContinuityRevision')::numeric < 1
      or (candidate ->> 'templateContinuityRevision')::numeric > 9007199254740991
      or (candidate ->> 'templateContinuityRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'templateContinuityRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;
    prepared_templates := candidate -> 'preparedTemplates';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'preparedTemplates'
    or candidate ? 'sourceRoleId'
    or candidate ? 'templateContinuityRevision' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry template evidence';
  end if;

  if operation_name = 'create_custom' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'preparedTemplates',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'preparedTemplates', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
    end if;
  end if;

  if operation_name <> 'retire_role' then
    policy_choice := candidate -> 'assignmentPolicy';
    if policy_choice ->> 'kind' = 'standing' then
      if policy_choice <> pg_catalog.jsonb_build_object('kind', 'standing') then
        raise exception using errcode = '22023', message = 'Standing policy shape is invalid';
      end if;
      target_assignment_policy := 'standing';
    elsif policy_choice ->> 'kind' = 'activation_required'
      and policy_choice - array['kind', 'activationPolicy']::text[] = '{}'::jsonb
      and policy_choice ?& array['kind', 'activationPolicy']
      and pg_catalog.jsonb_typeof(policy_choice -> 'activationPolicy') = 'object' then
      target_assignment_policy := 'activation_required';
      if policy_choice #>> '{activationPolicy,selection}' = 'existing' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'reference']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'reference'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,reference}') <>
            'object' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy shape is invalid';
        end if;
        policy_reference := policy_choice #> '{activationPolicy,reference}';
        if policy_reference - array[
          'activationPolicyId', 'revision', 'fingerprint'
        ]::text[] <> '{}'::jsonb
          or not (policy_reference ?& array[
            'activationPolicyId', 'revision', 'fingerprint'
          ])
          or pg_catalog.jsonb_typeof(policy_reference -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_reference -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_reference -> 'fingerprint') <> 'string'
          or (policy_reference ->> 'revision')::numeric < 1
          or (policy_reference ->> 'revision')::numeric > 9007199254740991
          or (policy_reference ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_reference ->> 'revision')::numeric)
          or policy_reference ->> 'fingerprint' !~ '^sha256:[a-f0-9]{64}$' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy evidence is invalid';
        end if;
        target_activation_policy_id := (policy_reference ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_reference ->> 'revision')::numeric::bigint;
        target_activation_policy_fingerprint := policy_reference ->> 'fingerprint';
      elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'policy']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'policy'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,policy}') <> 'object' then
          raise exception using errcode = '22023',
            message = 'New activation policy shape is invalid';
        end if;
        policy_value := policy_choice #> '{activationPolicy,policy}';
        if policy_value - array[
          'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
          'reasonRequired', 'recentAuthentication', 'requiredCallerExecutionBindingId'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or (
            policy_value ? 'requiredCallerExecutionBindingId'
            and (
              pg_catalog.jsonb_typeof(policy_value -> 'requiredCallerExecutionBindingId') <>
                'string'
              or not vortex_context.is_non_nil_uuid(
                policy_value ->> 'requiredCallerExecutionBindingId'
              )
            )
          )
          or (policy_value ->> 'revision')::numeric < 1
          or (policy_value ->> 'revision')::numeric > 9007199254740991
          or (policy_value ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_value ->> 'revision')::numeric)
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric < 1
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric >
            9007199254740991
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric <>
            pg_catalog.trunc(
              (policy_value ->> 'maximumActivationDurationSeconds')::numeric
            ) then
          raise exception using errcode = '22023',
            message = 'New activation policy evidence is invalid';
        end if;
        if policy_value #>> '{recentAuthentication,kind}' = 'none' then
          if policy_value -> 'recentAuthentication' <>
            pg_catalog.jsonb_build_object('kind', 'none') then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        elsif policy_value #>> '{recentAuthentication,kind}' in ('primary', 'multi_factor') then
          if (policy_value -> 'recentAuthentication') - array[
            'kind', 'maximumAgeSeconds'
          ]::text[] <> '{}'::jsonb
            or not ((policy_value -> 'recentAuthentication') ?& array[
              'kind', 'maximumAgeSeconds'
            ])
            or pg_catalog.jsonb_typeof(
              policy_value #> '{recentAuthentication,maximumAgeSeconds}'
            ) <> 'number'
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric < 1
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric >
              9007199254740991
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric <>
              pg_catalog.trunc(
                (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric
              ) then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        else
          raise exception using errcode = '22023',
            message = 'Recent authentication policy is invalid';
        end if;
        target_activation_policy_id := (policy_value ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_value ->> 'revision')::numeric::bigint;
        supplied_new_policy_fingerprint := p_evidence ->> 'newActivationPolicyFingerprint';
        if supplied_new_policy_fingerprint is null then
          raise exception using errcode = '22023',
            message = 'New activation policy fingerprint is required';
        end if;
        target_activation_policy_fingerprint := supplied_new_policy_fingerprint;
      else
        raise exception using errcode = '22023',
          message = 'Activation-required policy selection is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Assignment policy is invalid';
    end if;
  end if;

  if (policy_value is not null) is distinct from
      (p_evidence ? 'newActivationPolicyFingerprint') then
    raise exception using errcode = '22023',
      message = 'New activation policy fingerprint presence is invalid';
  end if;

  if candidate_permissions is not null then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'kind', 'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ])
        or item.value ->> 'kind' is distinct from 'exact'
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'continuityRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'catalogueFingerprint')
          is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'meaningFingerprint')
          is distinct from 'string'
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or item.value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or (item.value ->> 'acceptedRegistrationRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc(
            (item.value ->> 'acceptedRegistrationRevision')::numeric
          )
        or (item.value ->> 'continuityRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'continuityRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'continuityRevision')::numeric)
        or (
          item.value ->> 'ownerKind' = 'platform'
          and item.value ? 'applicationRootId'
        )
        or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId')
            is distinct from 'string'
        )
    ) then
      raise exception using errcode = '22023', message = 'Role permission entry is invalid';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'exact',
        'applicationRootId', case
          when item.value ? 'applicationRootId'
            then (item.value ->> 'applicationRootId')::uuid
          else null
        end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid,
        'acceptedRegistrationRevision',
          (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
        'catalogueFingerprint', item.value ->> 'catalogueFingerprint',
        'continuityRevision',
          (item.value ->> 'continuityRevision')::numeric::bigint,
        'meaningFingerprint', item.value ->> 'meaningFingerprint'
      )) order by
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end nulls last,
        (item.value ->> 'ownerKind') collate "C",
        (item.value ->> 'ownerId')::uuid,
        (item.value ->> 'permissionId')::uuid
    ) into canonical_permissions
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);

    if canonical_permissions is distinct from candidate_permissions then
      raise exception using errcode = '22023',
        message = 'Role permissions must use canonical unique identity order';
    end if;
    select pg_catalog.count(*), pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      case when item.value ? 'applicationRootId'
        then (item.value ->> 'applicationRootId')::uuid else null end,
      item.value ->> 'ownerKind',
      (item.value ->> 'ownerId')::uuid,
      (item.value ->> 'permissionId')::uuid
    ))
    into permission_count, selected_template_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);
    if permission_count <> selected_template_count then
      raise exception using errcode = '22023',
        message = 'Role permission identities must be unique';
    end if;
  end if;

  supplied_accepted_grant_fingerprint := p_evidence ->> 'acceptedGrantFingerprint';
  if operation_name in ('accept_new_application_role', 'accept_application_role_revision') then
    if supplied_accepted_grant_fingerprint is null then
      raise exception using errcode = '22023',
        message = 'Application acceptance fingerprint is required';
    end if;
  elsif supplied_accepted_grant_fingerprint is not null then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry accepted-grant evidence';
  end if;

  if prepared_templates is not null then
    if prepared_templates - array[
      'contractVersion', 'preparationBasis', 'permissionRegistration',
      'templates', 'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates', 'candidateFingerprint'
      ])
      or prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(prepared_templates -> 'preparationBasis') <> 'object'
      or (prepared_templates -> 'preparationBasis') - array[
        'kind', 'registrationRevision'
      ]::text[] <> '{}'::jsonb
      or not ((prepared_templates -> 'preparationBasis') ?& array[
        'kind', 'registrationRevision'
      ])
      or prepared_templates #>> '{preparationBasis,kind}' <>
        'current_active_registration'
      or pg_catalog.jsonb_typeof(
        prepared_templates #> '{preparationBasis,registrationRevision}'
      ) <> 'number'
      or (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric
        not between 1 and 9007199254740991
      or (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric <>
        pg_catalog.trunc(
          (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric
        )
      or pg_catalog.jsonb_typeof(prepared_templates -> 'permissionRegistration') <> 'object'
      or pg_catalog.jsonb_typeof(
        prepared_templates #> '{permissionRegistration,applicationRelease,releaseRevision}'
      ) <> 'number'
      or (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric
          not between 1 and 9007199254740991
      or (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric <>
          pg_catalog.trunc((prepared_templates #>>
            '{permissionRegistration,applicationRelease,releaseRevision}')::numeric)
      or pg_catalog.jsonb_typeof(prepared_templates -> 'templates') <> 'array'
      or pg_catalog.jsonb_array_length(prepared_templates -> 'templates') = 0
      or pg_catalog.jsonb_typeof(prepared_templates -> 'candidateFingerprint') <> 'string'
      or prepared_templates ->> 'candidateFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023',
        message = 'Prepared application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (prepared_templates #>> '{preparationBasis,registrationRevision}')::numeric::bigint;
    target_application_root_id :=
      (prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid;
    if (prepared_templates #>> '{permissionRegistration,organizationId}')::uuid <>
        target_organization_id
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or not vortex_access.application_permission_registration_matches_candidate(
        target_organization_id,
        target_application_root_id,
        target_accepted_registration_revision,
        prepared_templates -> 'permissionRegistration'
      ) then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
    into selected_template_count, selected_template
    from pg_catalog.jsonb_array_elements(prepared_templates -> 'templates') as item(value)
    where (item.value #>> '{template,roleId}')::uuid = target_source_role_id;
    if selected_template_count <> 1
      or pg_catalog.jsonb_typeof(selected_template) <> 'object'
      or selected_template - array[
        'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
      ]::text[] <> '{}'::jsonb
      or not (selected_template ?& array[
        'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
      ])
      or pg_catalog.jsonb_typeof(selected_template -> 'template') <> 'object'
      or pg_catalog.jsonb_typeof(selected_template -> 'livePermissions') <> 'array'
      or pg_catalog.jsonb_array_length(selected_template -> 'livePermissions') = 0
      or selected_template ->> 'sourceTemplateFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023',
        message = 'Selected application role-template evidence is invalid';
    end if;

    target_source_definition_key :=
      prepared_templates #>> '{permissionRegistration,applicationRelease,definitionKey}';
    target_source_release_revision :=
      (prepared_templates #>>
        '{permissionRegistration,applicationRelease,releaseRevision}')::numeric::bigint;
    target_source_release_version :=
      prepared_templates #>> '{permissionRegistration,applicationRelease,releaseVersion}';
    target_source_validation_contract_version :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,validationContractVersion}';
    target_source_content_fingerprint :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,contentFingerprint}';
    target_source_resolution_fingerprint :=
      prepared_templates #>>
        '{permissionRegistration,applicationRelease,resolutionFingerprint}';
    target_source_template_fingerprint :=
      selected_template ->> 'sourceTemplateFingerprint';
    target_source_catalogue_fingerprint :=
      prepared_templates #>> '{permissionRegistration,applicationCatalogueFingerprint}';

    if operation_name in ('accept_new_application_role', 'accept_application_role_revision') then
      target_accepted_grant_fingerprint := supplied_accepted_grant_fingerprint;
    end if;
  end if;
  supplied_role_candidate_fingerprint := p_evidence ->> 'roleCandidateFingerprint';

  manifest := p_evidence -> 'affectedAssignmentManifest';

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-change scope is unavailable';
  end if;

  if candidate_permissions is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on registration.organization_id = target_organization_id
      and registration.registration_kind = case
        when item.value ->> 'ownerKind' = 'platform' then 'platform'
        else 'application'
      end
      and registration.registration_owner_id = case
        when item.value ->> 'ownerKind' = 'platform'
          then 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        else (item.value ->> 'applicationRootId')::uuid
      end
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
      and registration.state = 'active'
    order by registration.registration_kind collate "C",
      registration.registration_owner_id
    for update of registration;

    perform 1
    from vortex_access.permission_continuities as continuity
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on continuity.organization_id = target_organization_id
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id
    for update of continuity;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (item.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint = item.value ->> 'meaningFingerprint'
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_kind = continuity.registration_kind
      and registration.registration_owner_id = continuity.registration_owner_id
      and registration.state = 'active'
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
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
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions) then
      raise exception using errcode = '40001',
        message = 'Role permission evidence is stale or unavailable';
    end if;
  end if;

  if prepared_templates is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
    ;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application registration is stale or unavailable';
    end if;

    perform 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = target_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.continuity_revision = target_template_continuity_revision
      and continuity.source_template_fingerprint = target_source_template_fingerprint
      and continuity.last_processed_registration_revision =
        target_accepted_registration_revision
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as permission(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        selected_template -> 'livePermissions'
      ) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value #>> '{permission,permissionId}')::uuid =
          (permission.value ->> 'permissionId')::uuid
        and live.value ->> 'meaningFingerprint' =
          permission.value ->> 'meaningFingerprint'
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(selected_template -> 'livePermissions')
      ) then
      raise exception using errcode = '40001',
        message = 'Role permissions do not match the current application template';
    end if;
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if found then
      raise exception using errcode = '40001',
        message = 'Organization role identity already exists';
    end if;

    target_role_revision := 1;
    target_policy_continuity_revision := 1;
    target_authority_continuity_revision := 1;
    target_role_kind := case
      when operation_name = 'accept_new_application_role' then 'application'
      else 'custom'
    end;
    target_lifecycle := 'active';
    operation_at := pg_catalog.clock_timestamp();

    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, derived_application_root_id, derived_source_role_id,
      derived_source_definition_key, derived_source_release_revision,
      derived_source_release_version, derived_source_validation_contract_version,
      derived_source_content_fingerprint, derived_source_resolution_fingerprint,
      derived_source_template_fingerprint, live_revision, created_by, created_at
    ) values (
      target_organization_id, target_role_id, target_role_kind, target_role_key,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      case when target_role_kind = 'application' then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_application_root_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_definition_key else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_revision else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_validation_contract_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_content_fingerprint else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_resolution_fingerprint else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_template_fingerprint else null end,
      1, p_changed_by, operation_at
    );

    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;

    if operation_name = 'create_custom_from_template' then
      target_application_root_id := null;
      target_source_role_id := null;
      target_source_definition_key := null;
      target_source_release_revision := null;
      target_source_release_version := null;
      target_source_validation_contract_version := null;
      target_source_content_fingerprint := null;
      target_source_resolution_fingerprint := null;
      target_source_template_fingerprint := null;
      target_source_catalogue_fingerprint := null;
      target_accepted_registration_revision := null;
      target_template_continuity_revision := null;
      target_accepted_grant_fingerprint := null;
    end if;
  else
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if not found or role_identity.live_revision <> expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale or unavailable';
    end if;
    if role_identity.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '23514',
        message = 'Current organization role revision is unavailable';
    end if;
    if current_revision.lifecycle = 'retired' then
      raise exception using errcode = '40001',
        message = 'A retired organization role is terminal';
    end if;
    if operation_name = 'revise_custom_permissions'
      and role_identity.role_kind <> 'custom' then
      raise exception using errcode = '40001',
        message = 'Custom role permission revision requires a custom role';
    end if;
    if operation_name = 'accept_application_role_revision'
      and (
        role_identity.role_kind <> 'application'
        or role_identity.application_root_id <> target_application_root_id
        or role_identity.source_role_id <> target_source_role_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application role acceptance targets the wrong role source';
    end if;
    target_role_revision := role_identity.live_revision + 1;
  end if;

  if operation_at is null then
    operation_at := pg_catalog.clock_timestamp();
  end if;
  if operation_name not in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    target_role_kind := role_identity.role_kind;
    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    target_lifecycle := case
      when operation_name = 'retire_role' then 'retired'
      else current_revision.lifecycle
    end;
    target_privilege_classification := case
      when operation_name = 'retire_role' then current_revision.privilege_classification
      else target_privilege_classification
    end;
    target_assignment_policy := case
      when operation_name = 'retire_role' then current_revision.assignment_policy
      else target_assignment_policy
    end;
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
      target_activation_policy_id := current_revision.activation_policy_id;
      target_activation_policy_revision := current_revision.activation_policy_revision;
      target_activation_policy_fingerprint := current_revision.activation_policy_fingerprint;
    end if;
    target_source_definition_key := current_revision.source_definition_key;
    target_source_release_revision := current_revision.source_release_revision;
    target_source_release_version := current_revision.source_release_version;
    target_source_validation_contract_version :=
      current_revision.source_validation_contract_version;
    target_source_content_fingerprint := current_revision.source_content_fingerprint;
    target_source_resolution_fingerprint := current_revision.source_resolution_fingerprint;
    target_source_template_fingerprint := current_revision.source_template_fingerprint;
    target_source_catalogue_fingerprint := current_revision.source_catalogue_fingerprint;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
    target_accepted_grant_fingerprint := current_revision.accepted_grant_fingerprint;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_source_content_fingerprint := null;
    target_source_resolution_fingerprint := null;
    target_source_template_fingerprint := null;
    target_source_catalogue_fingerprint := null;
    target_accepted_registration_revision := null;
    target_template_continuity_revision := null;
    target_accepted_grant_fingerprint := null;
  elsif operation_name = 'accept_application_role_revision' then
    target_lifecycle := 'active';
  end if;

  if operation_name <> 'retire_role' then
    if target_assignment_policy = 'standing' then
      target_activation_policy_id := null;
      target_activation_policy_revision := null;
      target_activation_policy_fingerprint := null;
    elsif policy_value is null then
      perform 1
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id
        and policy.revision = target_activation_policy_revision
        and policy.policy_fingerprint = target_activation_policy_fingerprint;
      if not found then
        raise exception using errcode = '40001',
          message = 'Existing role activation policy is stale or unavailable';
      end if;
    else
      select pg_catalog.max(policy.revision) into maximum_policy_revision
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id;
      if maximum_policy_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'New role activation policy revision is exhausted';
      end if;
      if (maximum_policy_revision is null and target_activation_policy_revision <> 1)
        or (maximum_policy_revision is not null
          and target_activation_policy_revision <> maximum_policy_revision + 1) then
        raise exception using errcode = '40001',
          message = 'New role activation policy revision is stale or invalid';
      end if;
    end if;
  end if;

  if current_revision.organization_id is not null then
    if current_revision.assignment_policy = target_assignment_policy
      and current_revision.activation_policy_id is not distinct from
        target_activation_policy_id
      and current_revision.activation_policy_revision is not distinct from
        target_activation_policy_revision
      and current_revision.activation_policy_fingerprint is not distinct from
        target_activation_policy_fingerprint then
      target_policy_continuity_revision := current_revision.policy_continuity_revision;
    else
      if current_revision.policy_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role policy continuity is exhausted';
      end if;
      target_policy_continuity_revision :=
        current_revision.policy_continuity_revision + 1;
    end if;
  end if;

  if current_revision.organization_id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      ),
      '[]'::jsonb
    ) into current_permissions
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    candidate_permissions := current_permissions;
  end if;
  permissions_changed := current_revision.organization_id is not null
    and candidate_permissions is distinct from current_permissions;

  if operation_name = 'revise_custom_permissions' and not permissions_changed then
    raise exception using errcode = '40001',
      message = 'Explicit custom permission revision must change the accepted set';
  end if;
  if operation_name = 'accept_application_role_revision'
    and current_revision.lifecycle = 'active'
    and not permissions_changed
    and current_revision.source_definition_key is not distinct from
      target_source_definition_key
    and current_revision.source_release_revision is not distinct from
      target_source_release_revision
    and current_revision.source_release_version is not distinct from
      target_source_release_version
    and current_revision.source_validation_contract_version is not distinct from
      target_source_validation_contract_version
    and current_revision.source_content_fingerprint is not distinct from
      target_source_content_fingerprint
    and current_revision.source_resolution_fingerprint is not distinct from
      target_source_resolution_fingerprint
    and current_revision.source_template_fingerprint is not distinct from
      target_source_template_fingerprint
    and current_revision.source_catalogue_fingerprint is not distinct from
      target_source_catalogue_fingerprint
    and current_revision.accepted_registration_revision is not distinct from
      target_accepted_registration_revision
    and current_revision.template_continuity_revision is not distinct from
      target_template_continuity_revision
    and current_revision.accepted_grant_fingerprint is not distinct from
      target_accepted_grant_fingerprint then
    raise exception using errcode = '40001',
      message = 'Explicit application acceptance must change accepted source evidence';
  end if;

  if current_revision.organization_id is not null then
    configured_state_changed :=
      current_revision.role_key is distinct from target_role_key
      or current_revision.label is distinct from target_label
      or current_revision.description is distinct from target_description
      or current_revision.privilege_classification is distinct from
        target_privilege_classification
      or current_revision.assignment_policy is distinct from target_assignment_policy
      or current_revision.activation_policy_id is distinct from target_activation_policy_id
      or current_revision.activation_policy_revision is distinct from
        target_activation_policy_revision
      or current_revision.activation_policy_fingerprint is distinct from
        target_activation_policy_fingerprint
      or current_revision.lifecycle is distinct from target_lifecycle
      or permissions_changed
      or current_revision.source_definition_key is distinct from target_source_definition_key
      or current_revision.source_release_revision is distinct from
        target_source_release_revision
      or current_revision.source_release_version is distinct from target_source_release_version
      or current_revision.source_validation_contract_version is distinct from
        target_source_validation_contract_version
      or current_revision.source_content_fingerprint is distinct from
        target_source_content_fingerprint
      or current_revision.source_resolution_fingerprint is distinct from
        target_source_resolution_fingerprint
      or current_revision.source_template_fingerprint is distinct from
        target_source_template_fingerprint
      or current_revision.source_catalogue_fingerprint is distinct from
        target_source_catalogue_fingerprint
      or current_revision.accepted_registration_revision is distinct from
        target_accepted_registration_revision
      or current_revision.template_continuity_revision is distinct from
        target_template_continuity_revision
      or current_revision.accepted_grant_fingerprint is distinct from
        target_accepted_grant_fingerprint;
    if not configured_state_changed then
      raise exception using errcode = '40001',
        message = 'Organization role candidate does not change configured state';
    end if;
  end if;

  if current_revision.organization_id is not null then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as proposed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(current_permissions) as existing(value)
        where existing.value -> 'applicationRootId' is not distinct from
            proposed.value -> 'applicationRootId'
          and existing.value ->> 'ownerKind' = proposed.value ->> 'ownerKind'
          and existing.value ->> 'ownerId' = proposed.value ->> 'ownerId'
          and existing.value ->> 'permissionId' = proposed.value ->> 'permissionId'
          and existing.value ->> 'continuityRevision' =
            proposed.value ->> 'continuityRevision'
          and existing.value ->> 'meaningFingerprint' =
            proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    manifest_required :=
      current_revision.assignment_policy <> target_assignment_policy
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if authority_broadened
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if current_revision.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision + 1;
    else
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision;
    end if;
  end if;

  if manifest_required then
    if manifest is null
      or manifest - array[
        'organizationId', 'roleId', 'roleCandidateFingerprint',
        'assignments', 'manifestFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (manifest ?& array[
        'organizationId', 'roleId', 'roleCandidateFingerprint',
        'assignments', 'manifestFingerprint'
      ])
      or pg_catalog.jsonb_typeof(manifest -> 'organizationId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleCandidateFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'assignments') <> 'array'
      or pg_catalog.jsonb_typeof(manifest -> 'manifestFingerprint') <> 'string'
      or (manifest ->> 'organizationId')::uuid <> target_organization_id
      or (manifest ->> 'roleId')::uuid <> target_role_id
      or manifest ->> 'roleCandidateFingerprint' <>
        supplied_role_candidate_fingerprint
      or manifest ->> 'manifestFingerprint' !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest shape is invalid';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(manifest -> 'assignments') as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or item.value - array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'expectedRevision') <> 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'assignee') <> 'object'
        or (item.value ->> 'expectedRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'expectedRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'expectedRevision')::numeric)
        or not (
          (
            item.value #>> '{assignee,kind}' = 'organization_account'
            and (item.value -> 'assignee') - array[
              'kind', 'organizationAccountId'
            ]::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array[
              'kind', 'organizationAccountId'
            ]
            and pg_catalog.jsonb_typeof(
              item.value #> '{assignee,organizationAccountId}'
            ) = 'string'
          )
          or (
            item.value #>> '{assignee,kind}' = 'group'
            and (item.value -> 'assignee') - array['kind', 'groupId']::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array['kind', 'groupId']
            and pg_catalog.jsonb_typeof(item.value #> '{assignee,groupId}') = 'string'
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest entry is invalid';
    end if;

    perform 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live'
    order by assignment.role_assignment_id
    for update;

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
              'kind', 'group', 'groupId', assignment.group_id
            )
          end
        ) order by assignment.role_assignment_id
      ),
      '[]'::jsonb
    ) into canonical_assignments
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live';

    if manifest -> 'assignments' is distinct from canonical_assignments then
      raise exception using errcode = '40001',
        message = 'Affected assignment manifest is stale or incomplete';
    end if;
  elsif manifest is not null then
    raise exception using errcode = '22023',
      message = 'This role change must not carry an affected assignment manifest';
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision, permission.meaning_fingerprint
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision
    order by permission.entry_ordinal;
  else
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint,
      item.value ->> 'meaningFingerprint'
    from pg_catalog.jsonb_array_elements(candidate_permissions) with ordinality
      as item(value, ordinality)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_root_id is not distinct from
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by item.ordinality;
  end if;

  -- A named required caller must be a current, active execution binding of this organisation;
  -- it is read without a lock because binding writers lock the binding before the access version.
  if policy_value ? 'requiredCallerExecutionBindingId' and not exists (
    select 1
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id =
        (policy_value ->> 'requiredCallerExecutionBindingId')::uuid
      and binding.organization_id = target_organization_id
      and binding.is_current
      and binding.state = 'active'
  ) then
    raise exception using errcode = '22023',
      message = 'Required caller execution binding is unavailable';
  end if;

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      policy_fingerprint, maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds, required_caller_execution_binding_id,
      changed_by, changed_at, change_correlation_id
    ) values (
      target_organization_id, target_role_id, target_activation_policy_id,
      target_activation_policy_revision, target_activation_policy_fingerprint,
      (policy_value ->> 'maximumActivationDurationSeconds')::numeric::bigint,
      (policy_value ->> 'reasonRequired')::boolean,
      policy_value #>> '{recentAuthentication,kind}',
      case when policy_value #>> '{recentAuthentication,kind}' = 'none' then null
        else (policy_value #>>
          '{recentAuthentication,maximumAgeSeconds}')::numeric::bigint end,
      (policy_value ->> 'requiredCallerExecutionBindingId')::uuid,
      p_changed_by, operation_at, p_correlation_id
    );
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification, target_assignment_policy,
    target_policy_continuity_revision, target_authority_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_activation_policy_fingerprint, target_role_key, target_label,
    target_description, target_source_definition_key,
    target_source_release_revision, target_source_release_version,
    target_source_validation_contract_version, target_source_content_fingerprint,
    target_source_resolution_fingerprint, target_source_template_fingerprint,
    target_source_catalogue_fingerprint, target_accepted_registration_revision,
    target_template_continuity_revision, target_accepted_grant_fingerprint,
    p_changed_by, operation_at, p_correlation_id
  );

  if current_revision.organization_id is not null then
    update vortex_access.organization_roles as stored
    set live_revision = target_role_revision,
      role_key = target_role_key
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
      and stored.live_revision = expected_role_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision changed concurrently';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    target_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_catalogue_changed'
  ) as version;

  select pg_catalog.jsonb_build_object(
    'roleId', revision.role_id,
    'organizationId', revision.organization_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'kind', revision.role_kind,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case
      when revision.assignment_policy = 'standing' then
        pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision,
          'fingerprint', revision.activation_policy_fingerprint
        )
      )
    end,
    'policyContinuityRevision', revision.policy_continuity_revision,
    'authorityContinuityRevision', revision.authority_continuity_revision,
    'lifecycle', revision.lifecycle,
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ), '[]'::jsonb),
    'createdByActorId', identity.created_by,
    'createdAt', identity.created_at,
    'changedByActorId', revision.changed_by,
    'changedAt', revision.changed_at,
    'changeCorrelationId', revision.change_correlation_id
  ) || case
    when revision.role_kind = 'application' then pg_catalog.jsonb_build_object(
      'applicationRootId', identity.application_root_id,
      'source', pg_catalog.jsonb_build_object(
        'applicationRootId', identity.application_root_id,
        'sourceRoleId', identity.source_role_id,
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', revision.source_definition_key,
          'rootId', identity.application_root_id,
          'releaseRevision', revision.source_release_revision,
          'releaseVersion', revision.source_release_version,
          'validationContractVersion', revision.source_validation_contract_version,
          'contentFingerprint', revision.source_content_fingerprint,
          'resolutionFingerprint', revision.source_resolution_fingerprint
        ),
        'sourceTemplateFingerprint', revision.source_template_fingerprint,
        'sourceCatalogueFingerprint', revision.source_catalogue_fingerprint,
        'acceptedRegistrationRevision', revision.accepted_registration_revision,
        'templateContinuityRevision', revision.template_continuity_revision,
        'acceptedGrantFingerprint', revision.accepted_grant_fingerprint
      )
    )
    when identity.derived_application_root_id is not null then
      pg_catalog.jsonb_build_object(
        'derivedFromTemplate', pg_catalog.jsonb_build_object(
          'applicationRootId', identity.derived_application_root_id,
          'sourceRoleId', identity.derived_source_role_id,
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', 'application',
            'definitionKey', identity.derived_source_definition_key,
            'rootId', identity.derived_application_root_id,
            'releaseRevision', identity.derived_source_release_revision,
            'releaseVersion', identity.derived_source_release_version,
            'validationContractVersion',
              identity.derived_source_validation_contract_version,
            'contentFingerprint', identity.derived_source_content_fingerprint,
            'resolutionFingerprint', identity.derived_source_resolution_fingerprint
          ),
          'sourceTemplateFingerprint', identity.derived_source_template_fingerprint
        )
      )
    else '{}'::jsonb
  end
  into role_result
  from vortex_access.organization_roles as identity
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = identity.organization_id
    and revision.role_id = identity.role_id
    and revision.revision = identity.live_revision
  where identity.organization_id = target_organization_id
    and identity.role_id = target_role_id;

  if policy_value is not null then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationId', policy.organization_id,
      'roleId', policy.role_id,
      'activationPolicyId', policy.activation_policy_id,
      'revision', policy.revision,
      'fingerprint', policy.policy_fingerprint,
      'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case
        when policy.authentication_requirement = 'none' then
          pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    )) into policy_result
    from vortex_access.organization_role_activation_policy_revisions as policy
    where policy.organization_id = target_organization_id
      and policy.role_id = target_role_id
      and policy.activation_policy_id = target_activation_policy_id
      and policy.revision = target_activation_policy_revision;
  end if;

  return query select 'changed'::text, operation_name, role_result,
    policy_result, next_access_version, p_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_role_change_without_stewardship_v1_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_v1_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

create or replace function vortex_access.list_organization_roles_for_administration(
  p_after_role_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  roles jsonb,
  next_after_role_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_items jsonb;
  page_role_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  with candidates as (
    select role.role_id, role.role_kind, role.application_root_id,
      role.source_role_id, revision.role_key, revision.label,
      revision.lifecycle, revision.revision, revision.privilege_classification,
      revision.assignment_policy, policy.maximum_activation_duration_seconds,
      policy.reason_required, policy.authentication_requirement,
      policy.authentication_maximum_age_seconds,
      policy.required_caller_execution_binding_id,
      (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = revision.organization_id
          and permission.role_id = revision.role_id
          and permission.role_revision = revision.revision
      ) as accepted_permission_count,
      pg_catalog.row_number() over (order by role.role_id) as ordinal
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    left join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
      and policy.policy_fingerprint = revision.activation_policy_fingerprint
    where role.organization_id = scope.organization_id
      and (p_after_role_id is null or role.role_id > p_after_role_id)
    order by role.role_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleId', candidate.role_id,
          'key', candidate.role_key,
          'label', candidate.label,
          'roleKind', candidate.role_kind,
          'lifecycle', candidate.lifecycle,
          'liveRevision', candidate.revision,
          'privilegeClassification', candidate.privilege_classification,
          'assignmentPolicy', case candidate.assignment_policy
            when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
            else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
              'kind', 'activation_required',
              'maximumActivationDurationSeconds',
                candidate.maximum_activation_duration_seconds,
              'reasonRequired', candidate.reason_required,
              'recentAuthentication', case candidate.authentication_requirement
                when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
                else pg_catalog.jsonb_build_object(
                  'kind', candidate.authentication_requirement,
                  'maximumAgeSeconds', candidate.authentication_maximum_age_seconds
                )
              end,
              'requiredCallerExecutionBindingId',
                candidate.required_caller_execution_binding_id
            ))
          end,
          'source', case candidate.role_kind
            when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
            else pg_catalog.jsonb_build_object(
              'kind', 'application',
              'applicationRootId', candidate.application_root_id,
              'sourceRoleId', candidate.source_role_id
            )
          end,
          'acceptedPermissionCount', candidate.accepted_permission_count
        ) order by candidate.role_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into role_items, page_role_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, role_items,
    case when candidate_count > p_page_size
      then page_role_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
to vortex_request;

comment on function
  vortex_access.list_organization_roles_for_administration(uuid, integer) is
  'Returns one bounded page of current local role configuration without effective-access evidence.';

create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end,
        'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
    and policy.policy_fingerprint = revision.activation_policy_fingerprint
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

create or replace function vortex_access.read_organization_role_activation_for_administration(
  p_role_activation_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  activation_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz;
  activation_value jsonb;
begin
  if p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role activation detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_build_object(
    'roleActivationId', activation.role_activation_id,
    'beneficiary', pg_catalog.jsonb_build_object(
      'organizationAccountId', activation.organization_account_id,
      'displayName', account.display_name
    ),
    'role', pg_catalog.jsonb_build_object(
      'roleId', activation.role_id,
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle
    ),
    'revision', activation.revision,
    'historicalRoleRevision', activation.historical_role_revision,
    'eligibilitySource', case activation.eligibility_source_kind
      when 'direct' then pg_catalog.jsonb_build_object(
        'kind', 'direct',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        )
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'eligibilityAssignment', pg_catalog.jsonb_build_object(
          'roleAssignmentId', activation.role_assignment_id,
          'revision', activation.role_assignment_revision
        ),
        'originatingMembership', pg_catalog.jsonb_build_object(
          'membershipId', activation.membership_id,
          'revision', activation.membership_revision
        )
      )
    end,
    'policyAtActivation', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'maximumActivationDurationSeconds',
        policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case policy.authentication_requirement
        when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
    )),
    'activatedAt', activation.activated_at,
    'expiresAt', activation.expires_at,
    'state', activation.state,
    'temporalState', case
      when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )
  into activation_value
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = activation.organization_id
    and policy.role_id = activation.role_id
    and policy.activation_policy_id = activation.activation_policy_id
    and policy.revision = activation.activation_policy_revision
    and policy.policy_fingerprint = activation.activation_policy_fingerprint
  where activation.organization_id = scope.organization_id
    and activation.role_activation_id = p_role_activation_id;

  return query select scope.organization_id,
    case when activation_value is null then 'unavailable' else 'available' end,
    activation_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_activation_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.read_organization_role_activation_for_administration(uuid) is
  'Returns one safe exact activation with historical source and policy settings, not current authority.';

create or replace function vortex_access.project_organization_role_change_summary(
  p_organization_id uuid,
  p_role_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'maximumActivationDurationSeconds',
          policy.maximum_activation_duration_seconds,
        'reasonRequired', policy.reason_required,
        'recentAuthentication', case policy.authentication_requirement
          when 'none' then pg_catalog.jsonb_build_object('kind', 'none')
          else pg_catalog.jsonb_build_object(
            'kind', policy.authentication_requirement,
            'maximumAgeSeconds', policy.authentication_maximum_age_seconds
          )
        end,
        'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id
      ))
    end,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
    and policy.policy_fingerprint = revision.activation_policy_fingerprint
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
$function$;

revoke execute on function
  vortex_access.project_organization_role_change_summary(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.project_organization_role_change_summary(uuid, uuid) is
  'Private safe current role projection for protected structural changes.';

create or replace function vortex_access.coordinate_organization_role_activation_change(
  p_operation text,
  p_organization_id uuid,
  p_role_activation_id uuid,
  p_expected_activation_revision bigint,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_requested_duration_seconds bigint,
  p_eligibility_source_kind text,
  p_role_assignment_id uuid,
  p_expected_role_assignment_revision bigint,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_invoking_execution_binding_id uuid default null
)
returns table (
  outcome text,
  operation text,
  activation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  activation_fact vortex_access.organization_role_activations%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  duration_cap_seconds numeric;
  source_seconds numeric;
  activation_expires_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in ('activate_role', 'revoke_role_activation')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-activation change input is invalid';
  end if;

  if p_operation = 'activate_role' then
    if p_expected_activation_revision is not null
      or p_organization_account_id is null
      or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_requested_duration_seconds is null
      or p_requested_duration_seconds not between 1 and 9007199254740991
      or p_eligibility_source_kind is null
      or p_eligibility_source_kind not in ('direct', 'group')
      or p_role_assignment_id is null
      or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_assignment_revision is null
      or p_expected_role_assignment_revision not between 1 and 9007199254740991
      or (
        p_eligibility_source_kind = 'direct'
        and (
          p_membership_id is not null
          or p_expected_membership_revision is not null
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          p_membership_id is null
          or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_expected_membership_revision is null
          or p_expected_membership_revision not between 1 and 9007199254740991
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role activation input is invalid';
    end if;
  elsif p_expected_activation_revision is null
    or p_expected_activation_revision not between 1 and 9007199254740991
    or p_organization_account_id is not null
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_requested_duration_seconds is not null
    or p_eligibility_source_kind is not null
    or p_role_assignment_id is not null
    or p_expected_role_assignment_revision is not null
    or p_membership_id is not null
    or p_expected_membership_revision is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-activation revocation input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-activation change scope is unavailable';
  end if;

  if p_operation = 'activate_role' then
    if exists (
      select 1
      from vortex_access.organization_role_activations as stored_activation
      where stored_activation.organization_id = p_organization_id
        and stored_activation.role_activation_id = p_role_activation_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation is stale or unavailable';
    end if;

    select role.live_revision, revision.lifecycle, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      revision.activation_policy_fingerprint,
      policy.maximum_activation_duration_seconds,
      policy.required_caller_execution_binding_id
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_activation_policy_revisions as policy
      on policy.organization_id = revision.organization_id
      and policy.role_id = revision.role_id
      and policy.activation_policy_id = revision.activation_policy_id
      and policy.revision = revision.activation_policy_revision
      and policy.policy_fingerprint = revision.activation_policy_fingerprint
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle not in ('active', 'acceptance_required')
      or role_fact.assignment_policy <> 'activation_required'
      or not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id = permission.organization_id
          and continuity.application_root_id is not distinct from
            permission.application_root_id
          and continuity.owner_kind = permission.owner_kind
          and continuity.owner_id = permission.owner_id
          and continuity.permission_id = permission.permission_id
          and continuity.state = 'available'
          and continuity.continuity_revision = permission.continuity_revision
          and continuity.meaning_fingerprint = permission.meaning_fingerprint
        where permission.organization_id = p_organization_id
          and permission.role_id = p_role_id
          and permission.role_revision = p_expected_role_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation role evidence is stale or unavailable';
    end if;

    -- A policy that names a required caller refuses every other invocation. The named
    -- binding must be the exact current, active, unexpired grant in this organisation whose
    -- effective actor is the actor making this change; a null or different value refuses.
    if role_fact.required_caller_execution_binding_id is not null
      and (
        p_invoking_execution_binding_id is distinct from
          role_fact.required_caller_execution_binding_id
        or not exists (
          select 1
          from vortex_access.flow_execution_bindings as binding
          where binding.execution_binding_id = p_invoking_execution_binding_id
            and binding.organization_id = p_organization_id
            and binding.is_current
            and binding.state = 'active'
            and (
              binding.expires_at is null
              or binding.expires_at > pg_catalog.clock_timestamp()
            )
            and (
              binding.actor_organization_account_id = p_changed_by
              or binding.actor_system_actor_id = p_changed_by
            )
        )
      ) then
      raise exception using errcode = '42501',
        message = 'Organization role activation requires its named caller';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role activation account is stale or unavailable';
    end if;

    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;
    if not found
      or assignment_fact.role_id <> p_role_id
      or assignment_fact.assignment_kind <> 'eligible'
      or assignment_fact.revision <> p_expected_role_assignment_revision
      or assignment_fact.state <> 'live'
      or (
        p_eligibility_source_kind = 'direct'
        and (
          assignment_fact.assignee_kind <> 'organization_account'
          or assignment_fact.organization_account_id <> p_organization_account_id
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and assignment_fact.assignee_kind <> 'group'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation eligibility is stale or unavailable';
    end if;

    if p_eligibility_source_kind = 'group' then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = assignment_fact.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization role activation Group is stale or unavailable';
      end if;

      select membership.* into membership_fact
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = p_organization_id
        and membership.membership_id = p_membership_id
      for update;
      if not found
        or membership_fact.group_id <> assignment_fact.group_id
        or membership_fact.organization_account_id <> p_organization_account_id
        or membership_fact.revision <> p_expected_membership_revision
        or membership_fact.state <> 'live' then
        raise exception using errcode = '40001',
          message = 'Organization role activation membership is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if assignment_fact.starts_at > checked_at
      or (
        assignment_fact.expires_at is not null
        and assignment_fact.expires_at <= checked_at
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          membership_fact.starts_at > checked_at
          or (
            membership_fact.expires_at is not null
            and membership_fact.expires_at <= checked_at
          )
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    duration_cap_seconds := least(
      p_requested_duration_seconds::numeric,
      role_fact.maximum_activation_duration_seconds::numeric
    );
    if assignment_fact.expires_at is not null then
      source_seconds := extract(
        epoch from assignment_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      source_seconds := extract(
        epoch from membership_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if duration_cap_seconds <= 0 then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    begin
      activation_expires_at := checked_at +
        (duration_cap_seconds::double precision * interval '1 second');
    exception
      when datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023',
          message = 'Organization role activation duration is not representable';
    end;
    if assignment_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        assignment_fact.expires_at
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        membership_fact.expires_at
      );
    end if;
    if activation_expires_at in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    ) or activation_expires_at <= checked_at then
      raise exception using errcode = '22023',
        message = 'Organization role activation duration is not representable';
    end if;

    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_activation_id, p_organization_account_id,
      p_role_id, 1, p_expected_role_revision,
      role_fact.authority_continuity_revision,
      role_fact.policy_continuity_revision, role_fact.activation_policy_id,
      role_fact.activation_policy_revision,
      role_fact.activation_policy_fingerprint, p_eligibility_source_kind,
      p_role_assignment_id, p_expected_role_assignment_revision,
      p_membership_id, p_expected_membership_revision, 'live', p_changed_by,
      checked_at, activation_expires_at, p_correlation_id, p_changed_by,
      checked_at, p_correlation_id, null, null, null
    ) returning * into activation_fact;
  else
    select stored_activation.* into activation_fact
    from vortex_access.organization_role_activations as stored_activation
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
    for update;

    if not found
      or activation_fact.revision <> p_expected_activation_revision
      or activation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
    if activation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role activation revision is exhausted';
    end if;

    operation_at := greatest(
      activation_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_activations as stored_activation
    set revision = activation_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
      and stored_activation.revision = p_expected_activation_revision
      and stored_activation.state = 'live'
    returning stored_activation.* into activation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_activation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'roleActivationId', activation_fact.role_activation_id,
      'organizationId', activation_fact.organization_id,
      'organizationAccountId', activation_fact.organization_account_id,
      'roleId', activation_fact.role_id,
      'revision', activation_fact.revision,
      'historicalRoleRevision', activation_fact.historical_role_revision,
      'authorityContinuityRevision',
        activation_fact.authority_continuity_revision,
      'policyContinuityRevision', activation_fact.policy_continuity_revision,
      'activationPolicy', pg_catalog.jsonb_build_object(
        'activationPolicyId', activation_fact.activation_policy_id,
        'revision', activation_fact.activation_policy_revision,
        'fingerprint', activation_fact.activation_policy_fingerprint
      ),
      'eligibilitySource', case activation_fact.eligibility_source_kind
        when 'direct' then pg_catalog.jsonb_build_object(
          'kind', 'direct',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          )
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          ),
          'originatingMembership', pg_catalog.jsonb_build_object(
            'membershipId', activation_fact.membership_id,
            'revision', activation_fact.membership_revision
          )
        )
      end,
      'state', activation_fact.state,
      'activatedByActorId', activation_fact.activated_by,
      'activatedAt', activation_fact.activated_at,
      'expiresAt', activation_fact.expires_at,
      'activationCorrelationId', activation_fact.activation_correlation_id,
      'changedByActorId', activation_fact.changed_by,
      'changedAt', activation_fact.changed_at,
      'changeCorrelationId', activation_fact.change_correlation_id,
      'revokedByActorId', activation_fact.revoked_by,
      'revokedAt', activation_fact.revoked_at,
      'revocationCorrelationId', activation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_activation_change(
    text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
    bigint, uuid, bigint, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid, uuid
) is
  'Owner-only atomic individual role activation or terminal revocation. It changes Access once but grants no caller authority; a policy that names a required caller refuses any other invoking execution binding.';

commit;
