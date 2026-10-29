set local role vortex_owner;

-- Existing pending invitations did not record a role intent; close them before requiring it.
alter table vortex_identity.organization_invitations
  add column role_intents jsonb not null default '[]'::jsonb;
update vortex_identity.organization_invitations
set revoked_at = greatest(pg_catalog.clock_timestamp(), changed_at),
    revoked_by_organization_account_id = invited_by_organization_account_id,
    changed_at = greatest(pg_catalog.clock_timestamp(), changed_at), revision = revision + 1
where accepted_at is null and revoked_at is null;
alter table vortex_identity.organization_invitations
  add constraint organization_invitations_role_intents_array check (pg_catalog.jsonb_typeof(role_intents) = 'array'),
  add constraint organization_invitations_pending_role_intent check (
    pg_catalog.jsonb_array_length(role_intents) > 0 or accepted_at is not null or revoked_at is not null
  );
alter table vortex_identity.organization_invitations alter column role_intents drop default;

drop function vortex_access.create_organization_invitation_for_administration(uuid, text, timestamptz);
drop function vortex_identity.create_organization_invitation(text, timestamptz);
drop function vortex_access.list_pending_invitations_for_identity(uuid, text);
drop function vortex_identity.accept_organization_invitation_with_transition(uuid, uuid, text, text, uuid);

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
      null::bigint as accepted_registration_revision,
      null::text as meaning_fingerprint
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
      ),
      coalesce(permission.value ->> 'meaningFingerprint', current_entry.meaning_fingerprint)
    from management_scopes as managed
    cross join lateral pg_catalog.jsonb_array_elements(
      case when managed.scope ->> 'kind' = 'bounded'
        then managed.scope -> 'permissions'
        else '[]'::jsonb
      end
    ) as permission(value)
    left join lateral (
      select catalogue.registration_revision, catalogue.meaning_fingerprint
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
      accepted.meaning_fingerprint as meaning_fingerprint
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
      (stored.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      stored.value ->> 'meaningFingerprint'
    ) as accepted
    where path.scope_kind = 'bounded'
  ), delegation_path_candidates as (
    select requirement.requirement_kind, requirement.application_root_id,
      requirement.owner_kind, requirement.owner_id,
      requirement.permission_id, requirement.accepted_registration_revision,
      requirement.meaning_fingerprint, path.route_rank,
      path.delegation_authority_id, path.membership_id,
      path.path_valid_until,
      pg_catalog.row_number() over (
        partition by requirement.requirement_kind,
          requirement.application_root_id, requirement.owner_kind,
          requirement.owner_id, requirement.permission_id,
          requirement.accepted_registration_revision,
          requirement.meaning_fingerprint
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
            and covered.meaning_fingerprint = requirement.meaning_fingerprint
        )
      )
    where requirement.requirement_kind <> 'organization_catalogue'
      or path.scope_kind = 'organization_catalogue'
  ), selected_delegation_paths as materialized (
    select candidate.requirement_kind, candidate.application_root_id,
      candidate.owner_kind, candidate.owner_id, candidate.permission_id,
      candidate.accepted_registration_revision, candidate.meaning_fingerprint,
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
      and selected.meaning_fingerprint is not distinct from requirement.meaning_fingerprint

  )
  select summary.requirement_count, summary.selected_count, summary.path_valid_until
  from delegation_summary as summary;
$function$;

alter function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.evaluate_organization_delegation_internal(uuid, uuid, timestamptz, timestamptz, jsonb) to vortex_owner, postgres;

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
        or not vortex_platform.is_non_nil_uuid(
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
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'ownerId')
      or not vortex_platform.is_non_nil_uuid(permission_candidate ->> 'permissionId')
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(permission_candidate) as supplied(key)
        where supplied.key <> all (array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'meaningFingerprint'
        ])
      )
      or (permission_candidate ? 'acceptedRegistrationRevision') <>
        (permission_candidate ? 'meaningFingerprint')
      or (permission_candidate ? 'acceptedRegistrationRevision' and (
        pg_catalog.jsonb_typeof(permission_candidate -> 'acceptedRegistrationRevision') <> 'number'
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric
          not between 1 and 9007199254740991
        or (permission_candidate ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc((permission_candidate ->> 'acceptedRegistrationRevision')::numeric)
        or pg_catalog.jsonb_typeof(permission_candidate -> 'meaningFingerprint') <> 'string'
        or permission_candidate ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
      ))
      or (
        permission_candidate ->> 'ownerKind' = 'platform'
        and permission_candidate ? 'applicationRootId'
      )
      or (
        permission_candidate ->> 'ownerKind' in ('application', 'module')
        and (
          not permission_candidate ? 'applicationRootId'
          or not vortex_platform.is_non_nil_uuid(
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
            pg_catalog.lower(permission.value ->> 'permissionId'),
            permission.value ->> 'acceptedRegistrationRevision',
            permission.value ->> 'meaningFingerprint'
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
  ), delegation_summary as (
    select * from vortex_access.evaluate_organization_delegation_internal(
      context_organization_value, context_account_value, context_expires_value,
      decision_checked_at, declaration_authority
    )
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
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb) owner to vortex_owner;

revoke execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_request, vortex_owner, postgres;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_owner;
comment on function vortex_access.evaluate_organization_permission_eligibility(jsonb) is
  'Returns transaction-bound permission and current delegation eligibility from one trusted operation declaration; it is not a final protected-operation decision.';
alter function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  owner to vortex_owner;

create or replace function vortex_access.check_organization_invitation_role_authority_internal(
  p_organization_id uuid, p_inviter_id uuid, p_role_id uuid, p_checked_at timestamptz
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  permissions jsonb;
  authority jsonb;
  delegation record;
begin
  select pg_catalog.jsonb_build_object(
    'organizationId', account.organization_id,
    'organizationAccountId', account.organization_account_id,
    'identityId', account.identity_id,
    'expiresAt', p_checked_at + interval '1 day'
  ) into context_value
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity on identity.identity_id = account.identity_id
  join vortex_identity.organizations as organization on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_inviter_id
    and account.state = 'active' and identity.state = 'active'
    and organization.state = 'active' and tenant.state = 'active';
  if context_value is null then return false; end if;

  if not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.invitations.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) or not exists (
    select 1 from vortex_access.evaluate_permission_role_path_internal(
      context_value, p_checked_at,
      vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      pg_catalog.jsonb_build_object('actionKind', 'manage'), null
    ) as path where path.path_valid_until > p_checked_at
  ) then return false; end if;

  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into permissions
  from (
    select distinct entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id, 'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
        'acceptedRegistrationRevision', entry.accepted_registration_revision,
        'meaningFingerprint', entry.meaning_fingerprint
      )) as permission
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_permission_entries as entry
      on entry.organization_id = role.organization_id and entry.role_id = role.role_id
      and entry.role_revision = role.live_revision
    where role.organization_id = p_organization_id and role.role_id = p_role_id
  ) as reference;
  if permissions is null then return false; end if;
  authority := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management', 'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', permissions)
  );
  select * into strict delegation from vortex_access.evaluate_organization_delegation_internal(
    p_organization_id, p_inviter_id, p_checked_at + interval '1 day', p_checked_at, authority
  );
  return delegation.requirement_count > 0 and delegation.requirement_count = delegation.selected_count;
end
$function$;

alter function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) owner to vortex_owner;
revoke all on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.check_organization_invitation_role_authority_internal(uuid, uuid, uuid, timestamptz) to postgres, vortex_owner;

CREATE OR REPLACE FUNCTION vortex_identity.protect_organization_invitation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.invitation_id is distinct from old.invitation_id
    or new.organization_id is distinct from old.organization_id
    or new.invited_email is distinct from old.invited_email
    or new.invited_by_organization_account_id is distinct from old.invited_by_organization_account_id
    or new.created_at is distinct from old.created_at
    or new.invited_at is distinct from old.invited_at
    or new.expires_at is distinct from old.expires_at
    or new.role_intents is distinct from old.role_intents then
    raise exception using errcode = '23514', message = 'Invitation identity and scope are permanent';
  end if;

  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception using errcode = '23514', message = 'A completed invitation cannot change';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at then
    raise exception using errcode = '40001', message = 'Invitation revision is stale or invalid';
  end if;

  return new;
end
$$;

alter function vortex_identity.protect_organization_invitation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_organization_invitation() FROM PUBLIC;

grant execute on function vortex_identity.protect_organization_invitation() to postgres;

create or replace function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_expires_at timestamptz,
  p_role_intents jsonb
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  invited_email text,
  invited_by uuid,
  created_at timestamptz,
  invited_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_organization_account_id uuid,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  new_invitation_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();
  if p_invited_email is null
    or p_invited_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or p_expires_at <= operation_at
    or pg_catalog.jsonb_typeof(p_role_intents) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_role_intents) = 0 then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  -- One pending invitation per email and organisation: inviting again while one waits is refused.
  -- Invitations of one email to one organisation are serialised, so two at once cannot both pass.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      checked ->> 'organizationId', p_invited_email), 3584)
  );
  if exists (
    select 1
    from vortex_identity.organization_invitations as pending
    where pending.organization_id = (checked ->> 'organizationId')::uuid
      and pending.invited_email = p_invited_email
      and pending.accepted_at is null
      and pending.revoked_at is null
      and pending.expires_at > operation_at
  ) then
    raise exception using errcode = '23505', message = 'Invitation is already pending';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, invited_by_organization_account_id,
    created_at, invited_at, expires_at, changed_at, revision, role_intents
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    (checked ->> 'organizationAccountId')::uuid,
    operation_at, operation_at, p_expires_at, operation_at, 1, p_role_intents
  );

  return query
  select invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.invitation_id = new_invitation_id;
end
$function$;

revoke all on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) is null;

alter function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) owner to vortex_owner;
grant execute on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) to postgres;

create or replace function vortex_identity.read_organization_invitation_for_administration_internal(
  p_organization_id uuid,
  p_invitation_id uuid
)
returns table (
  outcome text,
  invitation jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_invitation_id is null
    or p_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'invitationId', invitation.invitation_id,
    'organizationId', invitation.organization_id,
    'invitedEmail', invitation.invited_email,
    'invitedBy', invitation.invited_by_organization_account_id,
    'roleIntents', invitation.role_intents,
    'createdAt', invitation.created_at,
    'invitedAt', invitation.invited_at,
    'expiresAt', invitation.expires_at,
    'revokedAt', invitation.revoked_at,
    'revokedBy', invitation.revoked_by_organization_account_id,
    'acceptedAt', invitation.accepted_at,
    'acceptedOrganizationAccountId', invitation.accepted_organization_account_id,
    'changedAt', invitation.changed_at,
    'revision', invitation.revision
  ))
  into invitation_value
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and invitation.invitation_id = p_invitation_id;

  return query select
    case when invitation_value is null then 'unavailable' else 'available' end,
    invitation_value;
end
$function$;

revoke all on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.read_organization_invitation_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) owner to vortex_owner;
grant execute on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) to postgres;

create or replace function vortex_identity.list_organization_invitations_for_administration_internal(
  p_organization_id uuid,
  p_after_invitation_id uuid,
  p_page_size integer
)
returns table (
  invitations jsonb,
  next_after_invitation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_items jsonb;
  page_invitation_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration page input is invalid';
  end if;

  with candidates as (
    select invitation.invitation_id, invitation.organization_id,
      invitation.invited_email, invitation.invited_by_organization_account_id,
      invitation.created_at, invitation.invited_at, invitation.expires_at,
      invitation.revoked_at, invitation.revoked_by_organization_account_id,
      invitation.accepted_at, invitation.accepted_organization_account_id,
      invitation.changed_at, invitation.revision, invitation.role_intents,
      pg_catalog.row_number() over (order by invitation.invitation_id) as ordinal
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = p_organization_id
      and (
        p_after_invitation_id is null
        or invitation.invitation_id > p_after_invitation_id
      )
    order by invitation.invitation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'invitationId', candidate.invitation_id,
          'organizationId', candidate.organization_id,
          'invitedEmail', candidate.invited_email,
          'invitedBy', candidate.invited_by_organization_account_id,
          'roleIntents', candidate.role_intents,
          'createdAt', candidate.created_at,
          'invitedAt', candidate.invited_at,
          'expiresAt', candidate.expires_at,
          'revokedAt', candidate.revoked_at,
          'revokedBy', candidate.revoked_by_organization_account_id,
          'acceptedAt', candidate.accepted_at,
          'acceptedOrganizationAccountId', candidate.accepted_organization_account_id,
          'changedAt', candidate.changed_at,
          'revision', candidate.revision
        )) order by candidate.invitation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.invitation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into invitation_items, page_invitation_ids, candidate_count
  from candidates as candidate;

  return query select invitation_items,
    case when candidate_count > p_page_size
      then page_invitation_ids[p_page_size] else null end;
end
$function$;

revoke all on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.list_organization_invitations_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) owner to vortex_owner;
grant execute on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
  role_item record; role_intents jsonb := '[]'::jsonb;
  locked_version bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_role_ids is null or pg_catalog.cardinality(p_role_ids) = 0
    or exists (select 1 from pg_catalog.unnest(p_role_ids) as id where id is null or not vortex_platform.is_non_nil_uuid(id::text))
    or pg_catalog.cardinality(p_role_ids) <> (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_role_ids) as id) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'create_organization_invitation',
      scope.organization_id::text, p_invited_email, p_expires_at::text,
      (select pg_catalog.string_agg(id::text, ',' order by id) from pg_catalog.unnest(p_role_ids) as id)), 'UTF8'),
      'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select version.current_version into locked_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id for update;
  if locked_version is distinct from scope.access_version then
    raise exception using errcode = '40001', message = 'Invitation authority is stale';
  end if;
  for role_item in
    select role.role_id, role.live_revision, revision.lifecycle, revision.assignment_policy
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
    order by role.role_id for update of role
  loop
    if role_item.lifecycle <> 'active' or role_item.assignment_policy not in ('standing', 'activation_required')
      or not vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role_item.role_id, operation_at
      ) then
      raise exception using errcode = 'V3145', message = 'You cannot give this role';
    end if;
    role_intents := role_intents || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'roleId', role_item.role_id, 'roleRevision', role_item.live_revision
    ));
  end loop;
  if pg_catalog.jsonb_array_length(role_intents) <> pg_catalog.cardinality(p_role_ids) then
    raise exception using errcode = 'V3145', message = 'You cannot give this role';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at, role_intents
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) IS 'Protected role-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) RETURNS TABLE(outcome text, organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
  role_intent record;
  role_fact record;
  checked_at timestamptz;
  prior_account_state text;
  access_transition text := 'unchanged';
begin
  if p_invitation_id is null
    or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.organization_id into target_organization_id
  from vortex_identity.organization_invitations as candidate
  where candidate.invitation_id = p_invitation_id;

  if not found then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

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
    if exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = target_organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;


  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', target_organization_id::text, true
  );

  select candidate.* into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.organization_id = target_organization_id
    and candidate.invitation_id = p_invitation_id
  for update;

  if not found or invitation.revoked_at is not null or invitation.accepted_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  if invitation.invited_email <> p_verified_email then
    return query select 'wrong_address'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  checked_at := pg_catalog.clock_timestamp();
  if invitation.expires_at <= checked_at then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  for role_intent in
    select intent."roleId" as role_id, intent."roleRevision" as role_revision
    from pg_catalog.jsonb_to_recordset(invitation.role_intents)
      as intent("roleId" uuid, "roleRevision" bigint)
    order by intent."roleId"
  loop
    select role.live_revision, revision.lifecycle, revision.assignment_policy into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = target_organization_id and role.role_id = role_intent.role_id
    for update of role;
    if not found or role_fact.live_revision <> role_intent.role_revision
      or role_fact.lifecycle <> 'active'
      or role_fact.assignment_policy not in ('standing', 'activation_required') then
    return query select 'role_changed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
    if not vortex_access.check_organization_invitation_role_authority_internal(
      target_organization_id, invitation.invited_by_organization_account_id, role_intent.role_id, checked_at
    ) then
    return query select 'inviter_not_allowed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(invitation.role_intents) = 0 then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select account.state into prior_account_state
  from vortex_identity.organization_accounts as account
  where account.organization_id = target_organization_id and account.identity_id = p_identity_id
  for update;
  if not found then
    access_transition := 'activated';
  elsif prior_account_state <> 'active' then
    access_transition := 'reactivated';
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_invitation_id,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome = 'accepted' and access_transition <> 'unchanged' then
    select incremented.current_version into resulting_version
    from vortex_access.increment_organization_access_version(
      accepted.organization_id,
      accepted.organization_account_id,
      p_correlation_id,
      case access_transition
        when 'activated' then 'organization_account_activated'
        when 'reactivated' then 'organization_account_reactivated'
      end
    ) as incremented;

  elsif accepted.outcome = 'accepted' then
    select version.current_version into resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = accepted.organization_id;

    if not found then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
  end if;

  if accepted.outcome = 'accepted' then
    for role_intent in
      select intent."roleId" as role_id, intent."roleRevision" as role_revision
      from pg_catalog.jsonb_to_recordset(invitation.role_intents)
        as intent("roleId" uuid, "roleRevision" bigint)
      order by intent."roleId"
    loop
      select revision.assignment_policy into strict role_fact
      from vortex_access.organization_role_revisions as revision
      where revision.organization_id = target_organization_id
        and revision.role_id = role_intent.role_id and revision.revision = role_intent.role_revision;
      if not exists (
        select 1 from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = target_organization_id
          and assignment.role_id = role_intent.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = accepted.organization_account_id
          and assignment.assignment_kind = case role_fact.assignment_policy
            when 'standing' then 'standing' else 'eligible' end
          and assignment.state = 'live' and assignment.starts_at <= checked_at
          and (assignment.expires_at is null or assignment.expires_at > checked_at)
      ) then
        select changed.access_version into resulting_version
        from vortex_access.coordinate_organization_role_assignment_change(
          'grant', target_organization_id, pg_catalog.gen_random_uuid(), null,
          role_intent.role_id, role_intent.role_revision, 'organization_account',
          accepted.organization_account_id, null,
          case role_fact.assignment_policy when 'standing' then 'standing' else 'eligible' end,
          checked_at, null, invitation.invited_by_organization_account_id, p_correlation_id
        ) as changed;
      end if;
    end loop;
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id,
    accepted.organization_id, accepted.identity_id, accepted.display_name,
    accepted.state, accepted.language, accepted.time_zone,
    accepted.invitation_id, accepted.activated_at, accepted.suspended_at,
    accepted.closed_at, accepted.changed_at, accepted.state_changed_at,
    accepted.state_changed_by, accepted.state_change_correlation_id,
    accepted.revision, resulting_version;
end
$_$;

alter function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) IS 'Runtime acceptance of an invitation by the signed-in person whose verified email it names, under the organization access-version lock.';

REVOKE ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) TO vortex_runtime;

grant execute on function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) to postgres;

create or replace function vortex_access.list_pending_invitations_for_identity(
  p_identity_id uuid,
  p_verified_email text
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  organization_display_name text,
  tenant_display_name text,
  expires_at timestamptz,
  role_intents jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email)) then
    raise exception using errcode = '22023', message = 'Pending invitation lookup is invalid';
  end if;
  -- Include expired invitations so their recipient can see why joining is no longer possible.
  -- At most 20, soonest expiry first, in an active organisation without an active account.
  return query
  select invitation.invitation_id, invitation.organization_id, organization.display_name,
    tenant.display_name, invitation.expires_at, invitation.role_intents
  from vortex_identity.organization_invitations as invitation
  join vortex_identity.organizations as organization
    on organization.organization_id = invitation.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where invitation.invited_email = p_verified_email
    and invitation.accepted_at is null
    and invitation.revoked_at is null
    and organization.state = 'active'
    and tenant.state = 'active'
    and not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = invitation.organization_id
        and account.identity_id = p_identity_id
        and account.state = 'active'
    )
  order by (invitation.expires_at <= pg_catalog.statement_timestamp()), invitation.expires_at, invitation.invitation_id
  limit 20;
end
$function$;

revoke all on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
-- The server reads it for the verified identity of the signed-in session, outside any
-- organisation request (the person has no organisation account yet).
grant execute on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  to vortex_runtime, postgres;
alter function vortex_access.list_pending_invitations_for_identity(uuid, text) owner to vortex_owner;

reset role;
