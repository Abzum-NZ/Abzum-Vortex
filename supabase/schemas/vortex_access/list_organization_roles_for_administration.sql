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
