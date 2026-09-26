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
