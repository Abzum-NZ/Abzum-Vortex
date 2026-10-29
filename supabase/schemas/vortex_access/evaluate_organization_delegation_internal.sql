create or replace function vortex_access.evaluate_organization_delegation_internal(
  context_organization_value uuid,
  context_account_value uuid,
  context_expires_value timestamptz,
  decision_checked_at timestamptz,
  declaration_authority jsonb
)
returns table (requirement_count bigint, selected_count bigint, path_valid_until timestamptz)
language sql stable security invoker set search_path = ''
as $function$
  with management_scopes as materialized (
    select declaration_authority -> 'before' as scope
    where declaration_authority ->> 'kind' = 'delegated_management'
    union all
    select declaration_authority -> 'after'
    where declaration_authority ->> 'kind' = 'delegated_management'
  ), delegation_requirements as materialized (
    -- Existing role revisions name the meaning they accepted. New authority requests use the
    -- current meaning, so an older bounded delegation cannot confer widened permission scope.
    select 'organization_catalogue'::text as requirement_kind,
      null::uuid as application_root_id, null::text as owner_kind,
      null::uuid as owner_id, null::uuid as permission_id,
      null::bigint as accepted_registration_revision
    where exists (
      select 1 from management_scopes as managed
      where managed.scope ->> 'kind' = 'organization_catalogue'
    )
    union all
    select distinct 'bounded',
      case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid
        else null::uuid
      end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid,
      coalesce(
        (permission.value ->> 'acceptedRegistrationRevision')::bigint,
        current_entry.registration_revision
      )
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
    left join lateral (
      select catalogue.registration_revision
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = registration.organization_id
        and catalogue.registration_kind = registration.registration_kind
        and catalogue.registration_owner_id is not distinct from registration.registration_owner_id
        and catalogue.registration_revision = registration.revision
      where registration.organization_id = context_organization_value
        and registration.state = 'active'
        and not permission.value ? 'acceptedRegistrationRevision'
        and catalogue.application_root_id is not distinct from
          (permission.value ->> 'applicationRootId')::uuid
        and catalogue.owner_kind = permission.value ->> 'ownerKind'
        and catalogue.owner_id = (permission.value ->> 'ownerId')::uuid
        and catalogue.permission_id = (permission.value ->> 'permissionId')::uuid
    ) as current_entry on true
  ), current_delegation_paths as materialized (
    select 1 as route_rank, delegation.delegation_authority_id,
      null::uuid as membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value)
      ) as path_valid_until
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = context_account_value
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )

    union all

    select 2, delegation.delegation_authority_id,
      membership.membership_id, delegation.scope_kind,
      delegation.bounded_permissions,
      least(
        context_expires_value,
        coalesce(delegation.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from vortex_access.organization_delegation_authorities as delegation
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = delegation.organization_id
      and organization_group.group_id = delegation.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = delegation.organization_id
      and membership.group_id = delegation.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where delegation.organization_id = context_organization_value
      and delegation.holder_kind = 'group'
      and delegation.state = 'live'
      and delegation.starts_at <= decision_checked_at
      and (
        delegation.expires_at is null
        or delegation.expires_at > decision_checked_at
      )
  ), current_bounded_path_permissions as materialized (
    select path.delegation_authority_id, path.membership_id,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end as application_root_id,
      stored.value ->> 'ownerKind' as owner_kind,
      (stored.value ->> 'ownerId')::uuid as owner_id,
      (stored.value ->> 'permissionId')::uuid as permission_id,
      accepted.registration_revision as accepted_registration_revision,
      accepted as accepted_entry
    from current_delegation_paths as path
    cross join lateral pg_catalog.jsonb_array_elements(
      path.bounded_permissions
    ) as stored(value)
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      context_organization_value,
      case when stored.value ? 'applicationRootId'
        then (stored.value ->> 'applicationRootId')::uuid else null::uuid end,
      stored.value ->> 'ownerKind',
      (stored.value ->> 'ownerId')::uuid,
      (stored.value ->> 'permissionId')::uuid,
      (stored.value ->> 'continuityRevision')::numeric::bigint,
      (stored.value ->> 'acceptedRegistrationRevision')::numeric::bigint
    ) as accepted
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, requirement.accepted_registration_revision,
      path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id,
          requirement.accepted_registration_revision
        order by path.route_rank, path.delegation_authority_id,
          path.membership_id nulls first
      ) as path_ordinal
    from delegation_requirements as requirement
    join current_delegation_paths as path
      on path.scope_kind = 'organization_catalogue'
      or (
        requirement.requirement_kind = 'bounded'
        and exists (
          select 1
          from current_bounded_path_permissions as covered
          where covered.delegation_authority_id =
              path.delegation_authority_id
            and covered.membership_id is not distinct from path.membership_id
            and covered.application_root_id is not distinct from
              requirement.application_root_id
            and covered.owner_kind = requirement.owner_kind
            and covered.owner_id = requirement.owner_id
            and covered.permission_id = requirement.permission_id
            and requirement.accepted_registration_revision is not null
            and exists (
              select 1 from vortex_access.permission_catalogue_entries as required_entry
              where required_entry.organization_id = context_organization_value
                and required_entry.application_root_id is not distinct from requirement.application_root_id
                and required_entry.owner_kind = requirement.owner_kind
                and required_entry.owner_id = requirement.owner_id
                and required_entry.permission_id = requirement.permission_id
                and required_entry.registration_revision = requirement.accepted_registration_revision
                and required_entry.registration_kind = case
                  when requirement.application_root_id is null then 'platform' else 'application' end
                and required_entry.registration_owner_id = coalesce(
                  requirement.application_root_id, requirement.owner_id)
                and vortex_access.permission_meaning_is_same_internal(covered.accepted_entry, required_entry)
            )
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
      candidate.accepted_registration_revision,
      candidate.path_valid_until
    from delegation_path_candidates as candidate
    where candidate.path_ordinal = 1
  ), delegation_summary as (
    select pg_catalog.count(*) as requirement_count,
      pg_catalog.count(selected.requirement_kind) as selected_count,
      pg_catalog.min(selected.path_valid_until) as path_valid_until
    from delegation_requirements as requirement
    left join selected_delegation_paths as selected
      on selected.requirement_kind = requirement.requirement_kind
      and selected.application_root_id is not distinct from
        requirement.application_root_id
      and selected.owner_kind is not distinct from requirement.owner_kind
      and selected.owner_id is not distinct from requirement.owner_id
      and selected.permission_id is not distinct from requirement.permission_id
      and selected.accepted_registration_revision is not distinct from
        requirement.accepted_registration_revision

  )
  select summary.requirement_count, summary.selected_count, summary.path_valid_until
  from delegation_summary as summary;
$function$;

alter function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) to vortex_owner, postgres;
