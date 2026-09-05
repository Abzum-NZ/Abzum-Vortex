-- Owner-only atomic organisation-role governance composition. This validates
-- integrity and changes Access but grants no caller authority.

create function vortex_access.coordinate_organization_role_change(
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
          'reasonRequired', 'recentAuthentication', 'independentApprovalRequired'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication', 'independentApprovalRequired'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or pg_catalog.jsonb_typeof(policy_value -> 'independentApprovalRequired') <>
            'boolean'
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

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      policy_fingerprint, maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds, independent_approval_required,
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
      (policy_value ->> 'independentApprovalRequired')::boolean,
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
    select pg_catalog.jsonb_build_object(
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
      'independentApprovalRequired', policy.independent_approval_required,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    ) into policy_result
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
  vortex_access.coordinate_organization_role_change(jsonb, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_change(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';
