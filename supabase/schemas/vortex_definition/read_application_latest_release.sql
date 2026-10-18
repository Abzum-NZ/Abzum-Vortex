-- The latest published version of one ordinary Application of the request's organisation, for a
-- person who may manage the organisation's application installations. Installing and upgrading are
-- anchored to it; no draft right is needed.
create or replace function vortex_definition.read_application_latest_release(
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
  latest jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application latest release selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity; the owner role has no read access to the declarations table
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
      message = 'Application latest release authority is unavailable';
  end if;

  select pg_catalog.jsonb_build_object(
    'definitionKey', root.key,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'releaseNote', release.release_note
  ) into latest
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
    and root.application_origin_kind = 'ordinary';
  return latest;
end
$function$;

revoke all on function vortex_definition.read_application_latest_release(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_application_latest_release(uuid)
  to vortex_request, postgres;
comment on function vortex_definition.read_application_latest_release(uuid) is
  'Returns the latest published version of one ordinary Application of the request organisation to a caller holding platform.organization.applications.manage, or null when it has none.';
alter function vortex_definition.read_application_latest_release(uuid) owner to vortex_owner;
