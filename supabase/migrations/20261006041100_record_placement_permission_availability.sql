begin;

set local role vortex_access_owner;

create or replace function vortex_access.evaluate_organization_record_permission_availability(
  p_declaration jsonb
)
returns table (
  eligibility jsonb,
  organization_id uuid,
  organization_account_id uuid,
  application_root_id uuid,
  access_version bigint,
  correlation_id uuid,
  expires_at timestamptz,
  observed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at_value timestamptz;
  eligibility_value jsonb;
begin
  -- The placement entry point accepts exactly one permission; the private core validates all
  -- remaining declaration fields, including the action, target and exact record binding.
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or pg_catalog.jsonb_typeof(p_declaration -> 'requiredPermissions') is distinct from 'array'
  then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_declaration -> 'requiredPermissions') <> 1 then
    raise exception using errcode = '22023',
      message = 'Organization record permission declaration is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  checked_at_value := pg_catalog.clock_timestamp();
  eligibility_value := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, context_value, checked_at_value
  );

  -- These bindings come from the same validated context and time used by the eligibility core.
  return query select
    eligibility_value,
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'accessVersion')::bigint,
    (context_value ->> 'correlationId')::uuid,
    (context_value ->> 'expiresAt')::timestamptz,
    checked_at_value;
end;
$function$;

comment on function vortex_access.evaluate_organization_record_permission_availability(jsonb) is
  'Human-context-bound singleton record permission availability only; does not decide row access or invoke an operation.';

alter function vortex_access.evaluate_organization_record_permission_availability(jsonb)
  owner to vortex_access_owner;
revoke all on function vortex_access.evaluate_organization_record_permission_availability(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_permission_availability(jsonb)
  to vortex_request, postgres;

reset role;

commit;
