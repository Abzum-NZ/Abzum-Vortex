create or replace function vortex_access.read_current_organization_step_up_setting()
returns table (
  require_step_up boolean,
  revision bigint,
  changed_at timestamptz,
  changed_by_display_name text,
  can_change boolean,
  can_turn_off boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_value uuid;
  stored vortex_identity.organization_security_settings%rowtype;
  decision record;
  change_permitted boolean;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_value := (context_value ->> 'organizationId')::uuid;

  select setting.* into stored
  from vortex_identity.organization_security_settings as setting
  where setting.organization_id = organization_value;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Organization security settings are unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.step_up_setting.change',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.assignments.manage'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  change_permitted := decision.outcome = 'eligible'
    and decision.organization_id is not distinct from organization_value;

  return query select
    -- What a two-step check in this organisation answers now, from the one mapper, so the
    -- reading can never disagree with the check.
    (vortex_access.effective_authentication_requirement_internal(
      organization_value,
      pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600)
    ) ->> 'kind') = 'multi_factor',
    case when change_permitted then stored.revision else null end,
    case when change_permitted then stored.changed_at else null end,
    case when change_permitted then (
      select account.display_name
      from vortex_identity.organization_accounts as account
      where account.organization_id = organization_value
        and account.organization_account_id = stored.changed_by_account_id
    ) else null end,
    change_permitted,
    change_permitted and exists (
      select 1 from vortex_platform.instance_profile as profile
      where profile.kind = 'development'
    );
end
$function$;

comment on function vortex_access.read_current_organization_step_up_setting() is
  'Reads the two-step setting of the validated human organisation context. Every member sees whether two-step verification is required; the revision, the last change and who may change or turn it off are returned only to a holder of the organisation access-assignment permission.';

revoke all on function vortex_access.read_current_organization_step_up_setting()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.read_current_organization_step_up_setting()
  to vortex_request;

alter function vortex_access.read_current_organization_step_up_setting() owner to vortex_owner;

grant execute on function vortex_access.read_current_organization_step_up_setting() to postgres;
