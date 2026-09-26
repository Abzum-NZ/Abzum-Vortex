create or replace function vortex_definition.read_application_release_adoption_target(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  target_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application release adoption target command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target context is unavailable';
  end if;

  -- The offered target is only revealed to a caller who may manage this
  -- organisation's application installations. The decision is made by the same
  -- Access evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target authority is unavailable';
  end if;

  -- Only an application this organisation has installed offers an adoption
  -- target. Publication advances the root pointer but never touches the
  -- installation, so the offered target is the discovery pointer, not the
  -- active release.
  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'applicationRootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'currentReleaseVersion', release.release_version
  )
  into target_value
  from vortex_definition.roots as root
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id
    and exists (
      select 1
      from vortex_module.installation_bindings as binding
      where binding.organization_id = root.organization_id
        and binding.application_root_id = root.root_id
        and binding.state = 'active'
    );

  if target_value is null then
    raise exception using errcode = 'P0002',
      message = 'Application release adoption target is unavailable';
  end if;

  return target_value;
end
$function$;

revoke all on function vortex_definition.read_application_release_adoption_target(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_release_adoption_target(uuid)
  to vortex_request;
comment on function vortex_definition.read_application_release_adoption_target(uuid) is
  'Returns the published-current release identity an organisation with an installed application may deliberately adopt, for a caller holding platform.organization.applications.manage.';

create or replace function vortex_definition.read_application_release_adoption_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Application release adoption release-set command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set context is unavailable';
  end if;

  -- The exact release evidence is only revealed to a caller who may manage this
  -- organisation's application installations, decided by the same Access
  -- evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set authority is unavailable';
  end if;

  -- The same protected projection the ordinary human bound-release read returns;
  -- this caller has already proved installation-management authority above.
  return vortex_definition.read_application_bound_release_set(p_application_release_revision);
end
$function$;

revoke all on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint) is
  'Returns the exact bound Application and Module release set for one root and revision to a caller holding platform.organization.applications.manage in the validated human application context.';
