create or replace function vortex_access.change_organization_role_authority_for_administration(
  p_prepared_evidence jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  target_organization_id uuid;
  target_role_id uuid;
  operation_name text;
  changed record;
  changed_summary jsonb;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'roleCandidateFingerprint')
      is distinct from 'string'
    or p_activity_id is null
    or vortex_context.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Organization role-authority change input is invalid';
  end if;

  operation_name := p_prepared_evidence #>> '{candidate,operation}';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(p_prepared_evidence #> '{candidate,organizationId}')
      is distinct from 'string'
    or vortex_context.is_non_nil_uuid(
      p_prepared_evidence #>> '{candidate,organizationId}'
    ) is not true
    or pg_catalog.jsonb_typeof(p_prepared_evidence #> '{candidate,roleId}') is distinct from 'string'
    or vortex_context.is_non_nil_uuid(
      p_prepared_evidence #>> '{candidate,roleId}'
    ) is not true then
    raise exception using errcode = '22023',
      message = 'Organization role-authority change input is invalid';
  end if;

  target_organization_id := (p_prepared_evidence #>> '{candidate,organizationId}')::uuid;
  target_role_id := (p_prepared_evidence #>> '{candidate,roleId}')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_private_organization_role_authority_change(
    p_prepared_evidence, p_activity_id
  ) as result;

  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, target_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-authority change input is invalid';
end
$function$;

revoke execute on function vortex_access.change_organization_role_authority_for_administration(jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.change_organization_role_authority_for_administration(jsonb, uuid)
to vortex_request;

comment on function vortex_access.change_organization_role_authority_for_administration(jsonb, uuid) is
  'Standalone request entry: creates a custom role or accepts a supplied application role template through the existing owner-only role-authority composition, so the affected-assignment review, explicit acceptance evidence and permanent-steward safeguard are unchanged; returns the stored role summary and one Access version with no separate grant endpoint.';
