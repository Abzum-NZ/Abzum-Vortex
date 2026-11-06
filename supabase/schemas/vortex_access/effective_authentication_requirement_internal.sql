create or replace function vortex_access.effective_authentication_requirement_internal(
  p_organization_id uuid,
  p_requirement jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- Only a two-step requirement is ever relaxed, and only here. A requirement of any other kind,
  -- a missing organisation, a missing settings row and every other case keep the requirement as
  -- declared, so two-step verification stays required.
  if p_organization_id is null
    or p_requirement ->> 'kind' is distinct from 'multi_factor' then
    return p_requirement;
  end if;
  if exists (
      select 1
      from vortex_platform.instance_profile as profile
      where profile.kind = 'development'
    )
    and exists (
      select 1
      from vortex_identity.organization_security_settings as setting
      where setting.organization_id = p_organization_id
        and setting.require_step_up is false
    ) then
    -- The recent sign-in is never relaxed: it keeps the declared age.
    return pg_catalog.jsonb_build_object(
      'kind', 'primary', 'maximumAgeSeconds', p_requirement -> 'maximumAgeSeconds'
    );
  end if;
  return p_requirement;
end
$function$;

comment on function vortex_access.effective_authentication_requirement_internal(uuid, jsonb) is
  'The one place that reads the organisation two-step setting. A two-step requirement becomes a recent sign-in of the same age only on a development instance whose organisation turned the requirement off; everything else is returned as declared. The organisation comes only from the validated context. No request role can execute it.';

revoke all on function vortex_access.effective_authentication_requirement_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_access.effective_authentication_requirement_internal(p_organization_id uuid, p_requirement jsonb) owner to vortex_owner;

grant execute on function vortex_access.effective_authentication_requirement_internal(p_organization_id uuid, p_requirement jsonb) to postgres;
