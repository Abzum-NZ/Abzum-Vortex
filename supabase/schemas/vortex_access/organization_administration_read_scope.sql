create or replace function vortex_access.organization_administration_read_scope(
  p_operation_key text,
  p_unavailable_message text
)
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
  if p_operation_key is null
    or p_operation_key !~ '^platform\.organization\.[a-z_]+\.read$'
    or p_unavailable_message is null then
    raise exception using errcode = '22023', message = 'Organization administration read is invalid';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', p_operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(p_operation_key),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = p_unavailable_message;
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke all on function vortex_access.organization_administration_read_scope(text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_access.organization_administration_read_scope(text, text) is
  'Private fixed organisation-administration read authorization: the caller names one platform.organization.*.read operation and the sentence a refusal carries; returns the organisation, account and access version.';

alter function vortex_access.organization_administration_read_scope(text, text) owner to vortex_owner;
