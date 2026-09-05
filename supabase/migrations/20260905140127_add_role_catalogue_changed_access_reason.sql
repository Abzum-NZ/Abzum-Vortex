-- Standalone role creation, revision and retirement are distinct from role
-- assignment changes. Extend the existing closed V1 storage vocabulary without
-- rewriting historical Access-version rows or changing the legacy Team token.
alter table vortex_access.organization_access_versions
  drop constraint organization_access_versions_reason_valid;

alter table vortex_access.organization_access_versions
  add constraint organization_access_versions_reason_valid check (
    change_reason in (
      'organization_initialized',
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_catalogue_changed',
      'team_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    )
  );

create or replace function vortex_access.increment_organization_access_version(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_change_reason text
)
returns table (
  organization_id uuid,
  current_version bigint,
  changed_at timestamptz,
  changed_by uuid,
  change_correlation_id uuid,
  change_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_catalogue_changed',
      'team_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = operation_at,
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;
end
$function$;
