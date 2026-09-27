-- Reinstall each reader from its canonical definition under the Access service owner.

begin;

create or replace function vortex_access.evaluate_organization_permission_eligibility(
  p_declaration jsonb
)
returns table (
  outcome text,
  operation_key text,
  target_kind text,
  target_application_root_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  checked_at timestamptz,
  valid_until timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_action jsonb;
  declaration_target jsonb;
  declaration_permission jsonb;
  declaration_authentication jsonb;
  declaration_authority jsonb;
  scope_candidate jsonb;
  permission_candidate jsonb;
  scope_name text;
  operation_value text;
  target_kind_value text;
  target_application_value uuid;
  permission_application_value uuid;
  permission_owner_kind_value text;
  authority_kind_value text;
  context_value jsonb;
  context_organization_value uuid;
  context_account_value uuid;
  context_access_version_value bigint;
  context_application_value uuid;
  context_expires_value timestamptz;
  context_correlation_value uuid;
  authentication_deadline timestamptz;
  authentication_satisfied boolean := true;
  context_current boolean := true;
  target_context_satisfied boolean := true;
  unsupported_context boolean := false;
  decision_checked_at timestamptz;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or not p_declaration ?& array[
      'operationKey', 'action', 'target', 'requiredPermission',
      'recentAuthentication', 'authority'
    ]
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_declaration) as supplied(key)
      where supplied.key <> all (array[
        'operationKey', 'action', 'target', 'requiredPermission',
        'recentAuthentication', 'authority'
      ])
    )
    or pg_catalog.jsonb_typeof(p_declaration -> 'operationKey') <> 'string'
    or pg_catalog.char_length(p_declaration ->> 'operationKey') not between 3 and 120
    or (p_declaration ->> 'operationKey') !~
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    or (p_declaration ->> 'operationKey') ~ '(^|\.)[^.]{41,}(\.|$)' then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  declaration_action := p_declaration -> 'action';
  declaration_target := p_declaration -> 'target';
  declaration_permission := p_declaration -> 'requiredPermission';
  declaration_authentication := p_declaration -> 'recentAuthentication';
  declaration_authority := p_declaration -> 'authority';

  if pg_catalog.jsonb_typeof(declaration_action) <> 'object'
    or not declaration_action ? 'actionKind'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(declaration_action) as supplied(key)
      where supplied.key <> all (array['actionKind', 'namedAction'])
    )
    or pg_catalog.jsonb_typeof(declaration_action -> 'actionKind') <> 'string'
    or declaration_action ->> 'actionKind' not in (
      'create', 'read', 'update', 'delete', 'restore', 'export', 'share', 'manage', 'named'
    )
    or (
      (declaration_action ->> 'actionKind') = 'named'
      and (
        not declaration_action ? 'namedAction'
        or pg_catalog.jsonb_typeof(declaration_action -> 'namedAction') <> 'string'
        or pg_catalog.char_length(declaration_action ->> 'namedAction') not between 1 and 40
        or (declaration_action ->> 'namedAction') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      )
    )
    or (
      (declaration_action ->> 'actionKind') <> 'named'
      and declaration_action ? 'namedAction'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_target) <> 'object'
    or not declaration_target ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_target -> 'kind') <> 'string'
    or declaration_target ->> 'kind' not in ('organization', 'application')
    or (
      declaration_target ->> 'kind' = 'organization'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_target ->> 'kind' = 'application'
      and (
        not declaration_target ? 'applicationRootId'
        or not vortex_context.is_non_nil_uuid(
          declaration_target ->> 'applicationRootId'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_target) as supplied(key)
          where supplied.key <> all (array['kind', 'applicationRootId'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authentication) <> 'object'
    or not declaration_authentication ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authentication -> 'kind') <> 'string'
    or declaration_authentication ->> 'kind' not in ('none', 'primary', 'multi_factor')
    or (
      declaration_authentication ->> 'kind' = 'none'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
      and (
        not declaration_authentication ? 'maximumAgeSeconds'
        or pg_catalog.jsonb_typeof(
          declaration_authentication -> 'maximumAgeSeconds'
        ) <> 'number'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authentication) as supplied(key)
          where supplied.key <> all (array['kind', 'maximumAgeSeconds'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authentication ->> 'kind' in ('primary', 'multi_factor')
    and (
      (declaration_authentication ->> 'maximumAgeSeconds')::numeric < 1
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric >
        9007199254740991
      or (declaration_authentication ->> 'maximumAgeSeconds')::numeric <>
        pg_catalog.trunc(
          (declaration_authentication ->> 'maximumAgeSeconds')::numeric
        )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if pg_catalog.jsonb_typeof(declaration_authority) <> 'object'
    or not declaration_authority ? 'kind'
    or pg_catalog.jsonb_typeof(declaration_authority -> 'kind') <> 'string'
    or declaration_authority ->> 'kind' not in ('permission', 'delegated_management')
    or (
      declaration_authority ->> 'kind' = 'permission'
      and exists (
        select 1
        from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
        where supplied.key <> 'kind'
      )
    )
    or (
      declaration_authority ->> 'kind' = 'delegated_management'
      and (
        not declaration_authority ?& array['before', 'after']
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(declaration_authority) as supplied(key)
          where supplied.key <> all (array['kind', 'before', 'after'])
        )
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if pg_catalog.jsonb_typeof(scope_candidate) <> 'object'
        or not scope_candidate ? 'kind'
        or pg_catalog.jsonb_typeof(scope_candidate -> 'kind') <> 'string'
        or scope_candidate ->> 'kind' not in (
          'none', 'organization_catalogue', 'bounded'
        )
        or (
          scope_candidate ->> 'kind' in ('none', 'organization_catalogue')
          and exists (
            select 1
            from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
            where supplied.key <> 'kind'
          )
        )
        or (
          scope_candidate ->> 'kind' = 'bounded'
          and (
            not scope_candidate ? 'permissions'
            or pg_catalog.jsonb_typeof(scope_candidate -> 'permissions') <> 'array'
            or pg_catalog.jsonb_array_length(scope_candidate -> 'permissions') = 0
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(scope_candidate) as supplied(key)
              where supplied.key <> all (array['kind', 'permissions'])
            )
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;

    if declaration_authority -> 'before' ->> 'kind' = 'none'
      and declaration_authority -> 'after' ->> 'kind' = 'none' then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end if;

  for permission_candidate in
    select candidate.value
    from (
      select declaration_permission as value
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'before' ->> 'kind' = 'bounded'
          then declaration_authority -> 'before' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
      union all
      select scoped.value
      from pg_catalog.jsonb_array_elements(
        case
          when declaration_authority ->> 'kind' = 'delegated_management'
            and declaration_authority -> 'after' ->> 'kind' = 'bounded'
          then declaration_authority -> 'after' -> 'permissions'
          else '[]'::jsonb
        end
      ) as scoped(value)
    ) as candidate
  loop
    if pg_catalog.jsonb_typeof(permission_candidate) <> 'object'
      or not permission_candidate ?& array['ownerKind', 'ownerId', 'permissionId']
      or pg_catalog.jsonb_typeof(permission_candidate -> 'ownerKind') <> 'string'
      or permission_candidate ->> 'ownerKind' not in ('platform', 'application', 'module')
      or not vortex_context.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_context.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ])
      )
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_context.is_non_nil_uuid(
            permission_candidate ->> 'applicationRootId'
          )
        )
      )
      or (
        permission_candidate ->> 'ownerKind' = 'application'
        and pg_catalog.lower(permission_candidate ->> 'ownerId') <>
          pg_catalog.lower(permission_candidate ->> 'applicationRootId')
      ) then
      raise exception using errcode = '22023',
        message = 'Organization permission declaration is invalid';
    end if;
  end loop;

  if declaration_authority ->> 'kind' = 'delegated_management' then
    foreach scope_name in array array['before', 'after'] loop
      scope_candidate := declaration_authority -> scope_name;
      if scope_candidate ->> 'kind' = 'bounded'
        and (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(scope_candidate -> 'permissions')
        ) <> (
          select pg_catalog.count(distinct pg_catalog.concat_ws(
            ':',
            pg_catalog.lower(permission.value ->> 'applicationRootId'),
            permission.value ->> 'ownerKind',
            pg_catalog.lower(permission.value ->> 'ownerId'),
            pg_catalog.lower(permission.value ->> 'permissionId')
          ))
          from pg_catalog.jsonb_array_elements(
            scope_candidate -> 'permissions'
          ) as permission(value)
        ) then
        raise exception using errcode = '22023',
          message = 'Organization permission declaration is invalid';
      end if;
    end loop;
  end if;

  operation_value := p_declaration ->> 'operationKey';
  target_kind_value := declaration_target ->> 'kind';
  target_application_value := case
    when target_kind_value = 'application'
      then (declaration_target ->> 'applicationRootId')::uuid
    else null
  end;
  permission_application_value := case
    when declaration_permission ? 'applicationRootId'
      then (declaration_permission ->> 'applicationRootId')::uuid
    else null
  end;
  permission_owner_kind_value := declaration_permission ->> 'ownerKind';
  authority_kind_value := declaration_authority ->> 'kind';

  if (target_kind_value = 'organization' and permission_owner_kind_value <> 'platform')
    or (
      target_kind_value = 'application'
      and (
        permission_owner_kind_value = 'platform'
        or permission_application_value is distinct from target_application_value
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Organization permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_value := (context_value ->> 'organizationId')::uuid;
  context_account_value := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version_value := (context_value ->> 'accessVersion')::bigint;
  context_application_value := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  context_expires_value := (context_value ->> 'expiresAt')::timestamptz;
  context_correlation_value := (context_value ->> 'correlationId')::uuid;
  decision_checked_at := pg_catalog.clock_timestamp();
  context_current := context_expires_value > decision_checked_at;

  unsupported_context := context_value ? 'delegatedContext'
    or context_value ? 'supportContext';
  target_context_satisfied := target_kind_value = 'organization'
    or coalesce(context_application_value = target_application_value, false);

  authentication_deadline := vortex_access.recent_authentication_deadline_internal(
    context_value, decision_checked_at, declaration_authentication
  );
  authentication_satisfied := authentication_deadline is not null;

  return query
  with permission_eligibility as materialized (
    select evaluated.path_valid_until
    from vortex_access.evaluate_permission_role_path_internal(
      context_value, decision_checked_at, declaration_permission,
      declaration_action, null::uuid
    ) as evaluated
  ), management_scopes as materialized (
    select declaration_authority -> 'before' as scope
    where authority_kind_value = 'delegated_management'
    union all
    select declaration_authority -> 'after'
    where authority_kind_value = 'delegated_management'
  ), delegation_requirements as materialized (
    select 'organization_catalogue'::text as requirement_kind,
      null::uuid as application_root_id, null::text as owner_kind,
      null::uuid as owner_id, null::uuid as permission_id
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
      (permission.value ->> 'permissionId')::uuid
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
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
      (stored.value ->> 'permissionId')::uuid as permission_id
    from current_delegation_paths as path
    cross join lateral pg_catalog.jsonb_array_elements(
      path.bounded_permissions
    ) as stored(value)
    join vortex_access.permission_registrations as registration
      on registration.organization_id = context_organization_value
      and registration.state = 'active'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id is not distinct from
        registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.application_root_id is not distinct from case
        when stored.value ? 'applicationRootId'
          then (stored.value ->> 'applicationRootId')::uuid
        else null::uuid
      end
      and catalogue.owner_kind = stored.value ->> 'ownerKind'
      and catalogue.owner_id = (stored.value ->> 'ownerId')::uuid
      and catalogue.permission_id = (stored.value ->> 'permissionId')::uuid
      and catalogue.meaning_fingerprint =
        stored.value ->> 'meaningFingerprint'
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_root_id is not distinct from
        catalogue.application_root_id
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id is not distinct from
        catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (stored.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint =
        stored.value ->> 'meaningFingerprint'
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id
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
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
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
  ), decision as (
    select exists(select 1 from permission_eligibility) as permission_available,
      (
        select pg_catalog.min(selected.path_valid_until)
        from permission_eligibility as selected
      ) as path_valid_until,
      authority_kind_value = 'permission'
        or (
          delegation.requirement_count > 0
          and delegation.requirement_count = delegation.selected_count
        ) as delegation_satisfied,
      delegation.path_valid_until as delegation_valid_until
    from (select 1) as singleton
    cross join delegation_summary as delegation
  )
  select
    case
      when not context_current
        or unsupported_context or not target_context_satisfied then 'refused'
      when not decision.permission_available then 'refused'
      when decision.path_valid_until is null then 'refused'
      when not authentication_satisfied then 'refused'
      when not decision.delegation_satisfied then 'refused'
      else 'eligible'
    end,
    operation_value,
    target_kind_value,
    target_application_value,
    context_organization_value,
    context_account_value,
    context_access_version_value,
    decision_checked_at,
    case
      when context_current
        and not unsupported_context
        and target_context_satisfied
        and decision.permission_available
        and decision.path_valid_until is not null
        and authentication_satisfied
        and decision.delegation_satisfied
      then least(
        decision.path_valid_until,
        authentication_deadline,
        coalesce(decision.delegation_valid_until, context_expires_value)
      )
      else null
    end,
    context_correlation_value,
    case
      when not context_current
        or unsupported_context or not target_context_satisfied
        then 'target_policy_unavailable'
      when not decision.permission_available then 'permission_unavailable'
      when decision.path_valid_until is null then 'permission_not_effective'
      when not authentication_satisfied then 'authentication_unsatisfied'
      when not decision.delegation_satisfied then 'delegation_insufficient'
      else null
    end
  from decision;
end
$function$;
revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_module_owner, vortex_record_owner;
comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_access_owner;

create or replace function vortex_access.read_application_permission_snapshot(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  release_revision bigint,
  definition_key text,
  release_version text,
  validation_contract_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  catalogue_fingerprint text,
  permission_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $function$
  select registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint,
    coalesce(
      pg_catalog.array_agg(entry.permission_id order by
        entry.permission_key collate "C", entry.permission_id)
        filter (where entry.permission_id is not null),
      array[]::uuid[]
    )
  from vortex_access.permission_registrations as registration
  left join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
    and entry.owner_kind = 'application'
    and entry.administrative = false
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
  group by registration.organization_id, registration.registration_owner_id,
    registration.revision, registration.source_revision, registration.source_definition_key,
    registration.source_version,
    registration.validation_contract_version, registration.source_content_fingerprint,
    registration.source_resolution_fingerprint,
    registration.permission_catalogue_fingerprint
$function$;
revoke execute on function vortex_access.read_application_permission_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_application_permission_snapshot(uuid, uuid)
  to vortex_module_owner;
comment on function vortex_access.read_application_permission_snapshot(uuid, uuid) is
  'Owner-only active exact release reference and deterministic application-only permission snapshot; role templates remain in Definition.';
alter function vortex_access.read_application_permission_snapshot(uuid, uuid)
  owner to vortex_access_owner;

create or replace function vortex_access.read_available_permission(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  owner_kind text,
  owner_id uuid,
  permission_id uuid,
  permission_key text,
  label text,
  description text,
  record_type_id uuid,
  record_scope jsonb,
  field_policy jsonb,
  action_kind text,
  named_action text,
  administrative boolean,
  source_kind text,
  source_definition_key text,
  source_root_id uuid,
  source_version text,
  source_revision bigint,
  source_validation_contract_version text,
  source_content_fingerprint text,
  source_resolution_fingerprint text,
  source_catalogue_fingerprint text,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select entry.organization_id, entry.application_root_id, entry.registration_revision,
    entry.owner_kind, entry.owner_id, entry.permission_id, entry.permission_key,
    entry.label, entry.description, entry.record_type_id, entry.record_scope,
    entry.field_policy,
    entry.action_kind, entry.named_action, entry.administrative, entry.source_kind,
    entry.source_definition_key, entry.source_root_id, entry.source_version,
    entry.source_revision, entry.source_validation_contract_version,
    entry.source_content_fingerprint, entry.source_resolution_fingerprint,
    entry.source_catalogue_fingerprint, entry.meaning_fingerprint
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.state = 'active'
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id
    and (
      (p_owner_kind = 'platform' and p_application_root_id is null and entry.application_root_id is null)
      or (
        p_owner_kind in ('application', 'module')
        and p_application_root_id is not null
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and entry.application_root_id = p_application_root_id
      )
    )
$function$;
revoke execute on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid) is
  'Owner-only exact current permission lookup retaining application context, record scope and field policy.';
alter function vortex_access.read_available_permission(uuid, uuid, text, uuid, uuid)
  owner to vortex_access_owner;

create or replace function vortex_access.resolve_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid := (p_decision ->> 'organizationId')::uuid;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  contribution_route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  policy_changeable text[];
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
begin
  if p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Record field bounds require an allowed decision';
  end if;

  for contribution in
    select value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';
    contribution_route := contribution -> 'route';

    -- The current catalogue entry for this contribution's exact permission.
    -- Mirrors vortex_access.read_available_permission's own current-entry
    -- join: entry joined to its owning registration, filtered to 'active'.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    -- The decision just used this exact permission; a missing catalogue
    -- entry now is an internal inconsistency, not an ordinary refusal.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field bounds found no catalogue entry';
    end if;

    -- A superseded release would otherwise silently supply the policy. Eight
    -- fields are compared: the five identity/release fields plus
    -- validationContractVersion, contentFingerprint and
    -- resolutionFingerprint, so a release that changed only its content or
    -- resolution evidence (revision and version unchanged) is caught too.
    if catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion')
      or catalogue_entry.source_content_fingerprint
        is distinct from (contribution_source ->> 'contentFingerprint')
      or catalogue_entry.source_resolution_fingerprint
        is distinct from (contribution_source ->> 'resolutionFingerprint') then
      raise exception using errcode = '22023',
        message = 'Record field bounds found a superseded permission source';
    end if;

    -- No declared field policy means this contribution contributes no
    -- fields; it must not veto a different contribution that has one.
    if catalogue_entry.field_policy is null then
      continue;
    end if;

    -- A direct_share route can only narrow the permission's own policy, so
    -- readable/changeable fields are kept only when the route also names
    -- them; every other route kind contributes the policy as declared.
    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'readableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_changeable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'changeableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'changeableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    readable_ids := readable_ids || coalesce(policy_readable, array[]::text[]);
    changeable_ids := changeable_ids || coalesce(policy_changeable, array[]::text[]);
  end loop;

  readable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(readable_ids) as field(value)
    order by field.value
  );
  -- Changeable never exceeds readable, because every contribution's own
  -- changeable set already sits inside its own readable set: the policy
  -- validator enforces that for a permission, and the direct-share table
  -- enforces it for a share. Unioning subsets preserves it, so this only
  -- canonicalises.
  changeable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(changeable_ids) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(readable_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(changeable_ids)
  );
end
$function$;

revoke execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner;

grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_field_bounds_internal(jsonb) is
  'Private field-bounds resolution over one allowed exact-record access decision; looks each contribution''s field policy up from the live permission catalogue itself, never from a caller-supplied declaration.';

alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  owner to vortex_access_owner;

create or replace function vortex_access.resolve_record_read_field_bounds_internal(
  p_declaration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
  ctx jsonb;
  checked_at timestamptz;
  decision_organization_id uuid;
  account_id uuid;
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  permission_value jsonb;
  source_value jsonb;
  routes jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  route_readable text[];
  guaranteed text[] := array[]::text[];
  first_route boolean := true;
  covers_all_records boolean := false;
  condition_free boolean := true;
  wants_share boolean := false;
  member_group_ids uuid[];
  share_row record;
  share_intersection text[];
  share_seen boolean := false;
begin
  -- The planner only knows how to reason about a record read; anything else is
  -- a caller error, never a wider grant.
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction' then
    raise exception using errcode = '22023',
      message = 'Record read field-bounds declaration is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  decision_organization_id := (ctx ->> 'organizationId')::uuid;
  account_id := (ctx ->> 'organizationAccountId')::uuid;
  binding := p_declaration -> 'recordBinding';

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is admitted to no record, so it is guaranteed no
  -- field and nothing may be pushed.
  if eligibility ->> 'outcome' <> 'eligible' then
    return nothing;
  end if;

  -- A direct-share route narrows its permission to the individual share's own
  -- readable fields, which are current rows rather than a static declaration.
  -- When any eligible alternative can match through such a route, take the
  -- intersection of every current share's own bounds once, so a field that a
  -- share withholds is never treated as visible.
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(listed.value -> 'recordScope' -> 'routes', '[]'::jsonb)
    ) as listed_route(value)
    where listed_route.value ->> 'kind' = 'direct_share'
  ) into wants_share;

  if wants_share then
    -- The groups the caller belongs to now: an active group and a live,
    -- started, unexpired membership, exactly as the share tests require.
    select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
    into member_group_ids
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = decision_organization_id
      and membership.organization_account_id = account_id
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at);

    for share_row in
      select share.readable_field_ids
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = decision_organization_id
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_root_id is not distinct from case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
    loop
      if not share_seen then
        share_intersection := array(
          select pg_catalog.lower(field.value)
          from pg_catalog.unnest(share_row.readable_field_ids::text[]) as field(value)
        );
        share_seen := true;
      else
        share_intersection := array(
          select field.value
          from pg_catalog.unnest(share_intersection) as field(value)
          where field.value = any (
            select pg_catalog.lower(shared.value)
            from pg_catalog.unnest(share_row.readable_field_ids::text[]) as shared(value)
          )
        );
      end if;
    end loop;
  end if;

  -- Each record is admitted by at least one (alternative, route) pair, and the
  -- exact decision exposes the union of the fields of the pairs that admit it.
  -- A field is therefore guaranteed on every admitted record only when every
  -- pair that can admit a record exposes it: the intersection over every pair,
  -- never a union within one alternative. An ownership, all-records or
  -- relationship pair exposes its permission's policy; a direct-share pair
  -- exposes that policy narrowed by the share, bounded here by the common
  -- bounds of every current share, and with no current share it admits no
  -- record and constrains nothing. Any unknown route fails closed.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (permission_value ->> 'applicationRootId')::uuid
      and entry.owner_kind = permission_value ->> 'ownerKind'
      and entry.owner_id = (permission_value ->> 'ownerId')::uuid
      and entry.permission_id = (permission_value ->> 'permissionId')::uuid;

    -- The eligibility decision just used this exact permission; a missing or
    -- superseded catalogue entry is an internal inconsistency, not a refusal
    -- that silently widens what may be pushed.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found no catalogue entry';
    end if;

    if catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion')
      or catalogue_entry.source_content_fingerprint
        is distinct from (source_value ->> 'contentFingerprint')
      or catalogue_entry.source_resolution_fingerprint
        is distinct from (source_value ->> 'resolutionFingerprint') then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found a superseded permission source';
    end if;

    -- A permission with no declared field policy contributes no field at all,
    -- so nothing is guaranteed for the whole record type.
    if catalogue_entry.field_policy is null then
      return nothing;
    end if;

    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return nothing;
    end if;

    -- A saved condition narrows every route of its alternative, including an
    -- all-records route, per record; the scan's table narrowing cannot apply it.
    if (candidate -> 'recordScope') ? 'savedCondition' then
      condition_free := false;
    elsif exists (
      select 1 from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
      where listed_route.value ->> 'kind' = 'all_records'
    ) then
      covers_all_records := true;
    end if;

    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          route_readable := policy_readable;
        when 'direct_share' then
          if not share_seen then
            continue;
          end if;
          route_readable := array(
            select shared.value
            from pg_catalog.unnest(policy_readable) as shared(value)
            where shared.value = any (share_intersection)
          );
        else
          return nothing;
      end case;

      if first_route then
        guaranteed := array(
          select distinct field.value
          from pg_catalog.unnest(route_readable) as field(value)
        );
        first_route := false;
      else
        guaranteed := array(
          select field.value
          from pg_catalog.unnest(guaranteed) as field(value)
          where field.value = any (route_readable)
        );
      end if;
      if pg_catalog.cardinality(guaranteed) = 0 then
        return nothing;
      end if;
    end loop;
  end loop;

  guaranteed := array(
    select field.value from pg_catalog.unnest(guaranteed) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed),
    'coversAllRecords', covers_all_records,
    'conditionFree', condition_free
  );
end
$function$;

revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the fields every alternative route is guaranteed to expose on every record it can admit (the intersection over every alternative and route, each direct-share route narrowed by every current share''s own bounds), whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; any unknown route or missing policy yields no fields. It only decides which fields a scan may order or filter by and never decides access.';

alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  owner to vortex_access_owner;

create or replace function vortex_access.resolve_record_read_scan_routes_internal(
  p_declaration jsonb,
  p_ownership_mode text
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  alternatives jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most directly shared record identifiers one query carries. A caller
  -- with more is not narrowed by this route at all.
  shared_limit constant integer := 10000;
  ctx jsonb;
  checked_at timestamptz;
  binding jsonb;
  routes jsonb;
  eligibility jsonb;
  candidate jsonb;
  route jsonb;
  route_kind text;
  account_id uuid;
  member_group_ids uuid[];
  wants_owner boolean := false;
  wants_share boolean := false;
  -- Every route of every eligible alternative has an exact stored predicate, so
  -- a condition-free scan examines only rows the exact decision admits. When
  -- any route does not, that route's term is left true in the scan plan and no
  -- field is taken as readable for every scanned row.
  pushable boolean := true;
  shared_overflow boolean := false;
  shared uuid[] := array[]::uuid[];
  alternatives jsonb := '[]'::jsonb;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction'
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record read scan declaration is invalid';
  end if;

  -- The same one context and time sample the exact-record decision uses, and
  -- the same eligibility core: the eligible alternatives here are exactly the
  -- ones that decision would union for any single record.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  binding := p_declaration -> 'recordBinding';
  account_id := (ctx ->> 'organizationAccountId')::uuid;

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is refused for every record by that decision. The
  -- empty alternative list narrows the scan to nothing; the exact decision
  -- would refuse every row anyway.
  if eligibility ->> 'outcome' <> 'eligible' then
    return query select true, null::uuid, array[]::uuid[], array[]::uuid[], '[]'::jsonb;
    return;
  end if;

  -- One alternative per eligible permission, reduced to the two facts the scan
  -- plan consumes: its exact route list and its saved-condition envelope. A
  -- route list that is not an array is never reasoned about; returning a null
  -- alternative list leaves the scan unrestricted.
  for candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as item(value)
  loop
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return query select false, null::uuid, array[]::uuid[], array[]::uuid[], null::jsonb;
      return;
    end if;
    alternatives := alternatives || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'routes', routes,
      'savedCondition', case
        when candidate -> 'recordScope' ? 'savedCondition'
          then candidate -> 'recordScope' -> 'savedCondition'
        else null::jsonb
      end
    ));
    for route in
      select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      route_kind := route ->> 'kind';
      if route_kind = 'ownership' then
        wants_owner := true;
        if p_ownership_mode not in ('organization_account', 'group') then
          -- An inherited owner is reached only by a current-edge chase, and an
          -- ownership route over a record type that stores no owner admits no
          -- record: neither is a fixed stored predicate.
          pushable := false;
        end if;
      elsif route_kind = 'direct_share' then
        wants_share := true;
      else
        -- all_records admits every record; a relationship route is a
        -- relationship chase. Neither is a fixed stored predicate, so the scan
        -- is left unrestricted and the exact decision alone narrows it.
        pushable := false;
      end if;
    end loop;
  end loop;

  -- The groups the caller belongs to now: an active group and a live,
  -- started, unexpired membership, as the ownership and share tests require.
  select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
  into member_group_ids
  from vortex_access.organization_group_memberships as membership
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id = membership.organization_id
    and organization_group.group_id = membership.group_id
    and organization_group.state = 'active'
  where membership.organization_id = (ctx ->> 'organizationId')::uuid
    and membership.organization_account_id = account_id
    and membership.state = 'live'
    and membership.starts_at <= checked_at
    and (membership.expires_at is null or membership.expires_at > checked_at);

  if wants_share then
    -- The same current-share conditions as the exact-record contribution
    -- reader, over every record of this type instead of one. A caller with more
    -- shares than one query carries gets a null array: that route is not
    -- narrowed, rather than truncated.
    select coalesce(pg_catalog.array_agg(listed.record_id), array[]::uuid[])
    into shared
    from (
      select distinct share.record_id
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = (ctx ->> 'organizationId')::uuid
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_root_id is not distinct from case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
      limit shared_limit + 1
    ) as listed;
    if pg_catalog.cardinality(shared) > shared_limit then
      shared_overflow := true;
    end if;
  end if;

  if shared_overflow then
    -- That route is not narrowed, so no scanned row is guaranteed admitted.
    pushable := false;
  end if;

  return query select
    pushable,
    case when wants_owner and p_ownership_mode = 'organization_account'
      then account_id else null::uuid end,
    case when wants_owner and p_ownership_mode = 'group'
      then member_group_ids else array[]::uuid[] end,
    case when wants_share and not shared_overflow
      then shared else null::uuid[] end,
    alternatives;
end
$function$;

revoke all on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text) is
  'Private read-scan narrowing for the fixed record adapter: from the caller''s own current eligible read alternatives it returns the owner account, owner groups and directly shared record identifiers, the eligible alternatives reduced to their route lists and saved-condition envelopes, and whether every route has an exact stored predicate; it only narrows candidates and never replaces the exact-record decision.';

alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  owner to vortex_access_owner;

grant usage on schema vortex_context, vortex_identity to vortex_access_owner;

revoke all privileges on table
  vortex_access.permission_registrations,
  vortex_access.permission_catalogue_entries,
  vortex_access.permission_continuities,
  vortex_access.organization_roles,
  vortex_access.organization_role_revisions,
  vortex_access.organization_role_permission_entries,
  vortex_access.organization_role_assignments,
  vortex_access.organization_role_activations,
  vortex_access.organization_groups,
  vortex_access.organization_group_memberships,
  vortex_access.organization_delegation_authorities,
  vortex_access.organization_direct_record_shares
from vortex_access_owner;

grant select (
  organization_id,
  registration_kind,
  registration_owner_id,
  state,
  revision,
  source_definition_key,
  source_version,
  source_revision,
  validation_contract_version,
  source_content_fingerprint,
  source_resolution_fingerprint,
  permission_catalogue_fingerprint
)
on table vortex_access.permission_registrations to vortex_access_owner;

-- These readers and their invoker role-path helper use the complete catalogue row.
grant select on table vortex_access.permission_catalogue_entries to vortex_access_owner;

grant select (
  organization_id,
  application_root_id,
  owner_kind,
  owner_id,
  permission_id,
  registration_kind,
  registration_owner_id,
  state,
  continuity_revision,
  meaning_fingerprint,
  last_processed_registration_revision
)
on table vortex_access.permission_continuities to vortex_access_owner;

grant select (organization_id, role_id, live_revision)
on table vortex_access.organization_roles to vortex_access_owner;

grant select (
  organization_id,
  role_id,
  revision,
  lifecycle,
  assignment_policy,
  policy_continuity_revision,
  activation_policy_id,
  activation_policy_revision,
  activation_policy_fingerprint,
  authority_continuity_revision
)
on table vortex_access.organization_role_revisions to vortex_access_owner;

grant select (
  organization_id,
  role_id,
  role_revision,
  application_root_id,
  owner_kind,
  owner_id,
  permission_id,
  continuity_revision,
  meaning_fingerprint
)
on table vortex_access.organization_role_permission_entries to vortex_access_owner;

grant select (
  organization_id,
  role_assignment_id,
  role_id,
  assignee_kind,
  organization_account_id,
  group_id,
  assignment_kind,
  revision,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_role_assignments to vortex_access_owner;

grant select (organization_id, group_id, state)
on table vortex_access.organization_groups to vortex_access_owner;

grant select (
  organization_id,
  membership_id,
  group_id,
  organization_account_id,
  revision,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_group_memberships to vortex_access_owner;

grant select (
  organization_id,
  organization_account_id,
  role_id,
  authority_continuity_revision,
  policy_continuity_revision,
  activation_policy_id,
  activation_policy_revision,
  activation_policy_fingerprint,
  eligibility_source_kind,
  role_assignment_id,
  role_assignment_revision,
  state,
  activated_at,
  expires_at,
  membership_id,
  membership_revision
)
on table vortex_access.organization_role_activations to vortex_access_owner;

grant select (
  organization_id,
  delegation_authority_id,
  holder_kind,
  organization_account_id,
  group_id,
  scope_kind,
  bounded_permissions,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_delegation_authorities to vortex_access_owner;

grant select (
  organization_id,
  storage_scope,
  application_root_id,
  module_root_id,
  record_type_id,
  storage_contract_id,
  record_id,
  recipient_kind,
  organization_account_id,
  group_id,
  readable_field_ids,
  starts_at,
  expires_at,
  state
)
on table vortex_access.organization_direct_record_shares to vortex_access_owner;

create policy permission_registrations_access_owner_select
  on vortex_access.permission_registrations
  for select to vortex_access_owner using (true);
create policy permission_catalogue_entries_access_owner_select
  on vortex_access.permission_catalogue_entries
  for select to vortex_access_owner using (true);
create policy permission_continuities_access_owner_select
  on vortex_access.permission_continuities
  for select to vortex_access_owner using (true);
create policy organization_roles_access_owner_select
  on vortex_access.organization_roles
  for select to vortex_access_owner using (true);
create policy organization_role_revisions_access_owner_select
  on vortex_access.organization_role_revisions
  for select to vortex_access_owner using (true);
create policy organization_role_permission_entries_access_owner_select
  on vortex_access.organization_role_permission_entries
  for select to vortex_access_owner using (true);
create policy organization_role_assignments_access_owner_select
  on vortex_access.organization_role_assignments
  for select to vortex_access_owner using (true);
create policy organization_role_activations_access_owner_select
  on vortex_access.organization_role_activations
  for select to vortex_access_owner using (true);
create policy organization_groups_access_owner_select
  on vortex_access.organization_groups
  for select to vortex_access_owner using (true);
create policy organization_group_memberships_access_owner_select
  on vortex_access.organization_group_memberships
  for select to vortex_access_owner using (true);
create policy organization_delegation_authorities_access_owner_select
  on vortex_access.organization_delegation_authorities
  for select to vortex_access_owner using (true);
create policy organization_direct_record_shares_access_owner_select
  on vortex_access.organization_direct_record_shares
  for select to vortex_access_owner using (true);

grant execute on function vortex_access.validated_human_request_context()
  to vortex_access_owner;
grant execute on function vortex_access.recent_authentication_deadline_internal(
  jsonb, timestamptz, jsonb
) to vortex_access_owner;
grant execute on function vortex_access.evaluate_permission_role_path_internal(
  jsonb, timestamptz, jsonb, jsonb, uuid
) to vortex_access_owner;
grant execute on function vortex_access.evaluate_organization_record_permission_eligibility_internal(
  jsonb, jsonb, timestamptz
) to vortex_access_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_access_owner;
grant execute on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    uuid, timestamptz
  ) to vortex_access_owner;

commit;
