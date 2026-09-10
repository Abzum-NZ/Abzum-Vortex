-- Protected role reads expose current organization-owned role configuration and
-- exact registered application templates as separate resources. Neither result
-- is an effective-access or assignment decision.

create function vortex_access.organization_roles_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

create function vortex_access.list_organization_roles_for_administration(
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
      policy.independent_approval_required,
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
            else pg_catalog.jsonb_build_object(
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
              'independentApprovalRequired', candidate.independent_approval_required
            )
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

create function vortex_access.read_organization_role_for_administration(
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
      else pg_catalog.jsonb_build_object(
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
        'independentApprovalRequired', policy.independent_approval_required
      )
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

create function vortex_access.list_application_role_templates_for_administration(
  p_after_application_root_id uuid,
  p_after_source_role_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  templates jsonb,
  next_after_application_root_id uuid,
  next_after_source_role_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  template_items jsonb;
  page_application_root_ids uuid[];
  page_source_role_ids uuid[];
  candidate_count integer;
  cursor_absent boolean;
begin
  cursor_absent := p_after_application_root_id is null
    and p_after_source_role_id is null;
  if p_page_size is null or p_page_size not between 1 and 100
    or (
      cursor_absent
      or (
        p_after_application_root_id is not null
        and p_after_source_role_id is not null
      )
    ) is not true
    or p_after_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  with candidates as (
    select registration.registration_owner_id as application_root_id,
      (template.value ->> 'roleId')::uuid as source_role_id,
      template.value ->> 'key' as role_key,
      template.value ->> 'name' as role_label,
      template.value #>> '{permissionSelection,kind}' as permission_selection_kind,
      template.value -> 'permissionKeys' as permission_keys,
      pg_catalog.row_number() over (
        order by registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
      ) as ordinal
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
      and release.content_fingerprint = registration.source_content_fingerprint
      and release.resolution_fingerprint = registration.source_resolution_fingerprint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,roles}'
    ) as template(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = registration.organization_id
      and continuity.application_root_id = registration.registration_owner_id
      and continuity.source_role_id = (template.value ->> 'roleId')::uuid
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = registration.revision
    where registration.organization_id = scope.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (
        cursor_absent
        or (
          registration.registration_owner_id,
          (template.value ->> 'roleId')::uuid
        ) > (p_after_application_root_id, p_after_source_role_id)
      )
    order by registration.registration_owner_id,
      (template.value ->> 'roleId')::uuid
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'reference', pg_catalog.jsonb_build_object(
            'applicationRootId', candidate.application_root_id,
            'sourceRoleId', candidate.source_role_id
          ),
          'key', candidate.role_key,
          'label', candidate.role_label,
          'permissionSelectionKind', candidate.permission_selection_kind,
          'publishedPermissionKeys', candidate.permission_keys
        ) order by candidate.application_root_id, candidate.source_role_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.application_root_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.source_role_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into template_items, page_application_root_ids, page_source_role_ids,
    candidate_count
  from candidates as candidate;

  return query select scope.organization_id, template_items,
    case when candidate_count > p_page_size
      then page_application_root_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_source_role_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

create function vortex_access.read_application_role_template_for_administration(
  p_application_root_id uuid,
  p_source_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  template_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  template_value jsonb;
begin
  if p_application_root_id is null or p_source_role_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application role template detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_roles_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'reference', pg_catalog.jsonb_build_object(
      'applicationRootId', registration.registration_owner_id,
      'sourceRoleId', (template.value ->> 'roleId')::uuid
    ),
    'key', template.value ->> 'key',
    'label', template.value ->> 'name',
    'permissionSelectionKind', template.value #>> '{permissionSelection,kind}',
    'publishedPermissionKeys', template.value -> 'permissionKeys'
  )
  into template_value
  from vortex_access.permission_registrations as registration
  join vortex_definition.roots as root
    on root.root_id = registration.registration_owner_id
    and root.organization_id = registration.organization_id
    and root.kind = 'application'
    and root.key = registration.source_definition_key
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = registration.source_revision
    and release.release_version = registration.source_version
    and release.validation_contract_version = registration.validation_contract_version
    and release.content_fingerprint = registration.source_content_fingerprint
    and release.resolution_fingerprint = registration.source_resolution_fingerprint
  cross join lateral pg_catalog.jsonb_array_elements(
    release.compilation_output #> '{canonical,content,roles}'
  ) as template(value)
  join vortex_access.application_role_template_continuities as continuity
    on continuity.organization_id = registration.organization_id
    and continuity.application_root_id = registration.registration_owner_id
    and continuity.source_role_id = (template.value ->> 'roleId')::uuid
    and continuity.state = 'available'
    and continuity.last_processed_registration_revision = registration.revision
  where registration.organization_id = scope.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and (template.value ->> 'roleId')::uuid = p_source_role_id;

  return query select scope.organization_id,
    case when template_value is null then 'unavailable' else 'available' end,
    template_value, scope.access_version;
end
$function$;

revoke execute on function vortex_access.organization_roles_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.list_application_role_templates_for_administration(uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_application_role_template_for_administration(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_roles_for_administration(uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;
grant execute on function
  vortex_access.list_application_role_templates_for_administration(uuid, uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_application_role_template_for_administration(uuid, uuid)
to vortex_request;

comment on function vortex_access.organization_roles_administration_scope() is
  'Private fixed roles-read authorization for current local roles and registered templates.';
comment on function
  vortex_access.list_organization_roles_for_administration(uuid, integer) is
  'Returns one bounded page of current local role configuration without effective-access evidence.';
comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';
comment on function
  vortex_access.list_application_role_templates_for_administration(uuid, uuid, integer) is
  'Returns one bounded page of exact current registered application role templates.';
comment on function
  vortex_access.read_application_role_template_for_administration(uuid, uuid) is
  'Returns one exact template from an active current application registration.';
