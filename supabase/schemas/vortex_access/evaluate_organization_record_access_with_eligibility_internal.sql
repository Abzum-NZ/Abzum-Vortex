create or replace function vortex_access.evaluate_organization_record_access_with_eligibility_internal(
  p_declaration jsonb, p_target_record_id uuid, p_facts jsonb, p_eligibility jsonb
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select vortex_access.evaluate_organization_record_access_with_validated_types_internal(
    p_declaration, p_target_record_id, p_facts, p_eligibility, null::jsonb
  )
$function$;
alter function vortex_access.evaluate_organization_record_access_with_eligibility_internal(jsonb,uuid,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_access.evaluate_organization_record_access_with_eligibility_internal(jsonb,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.evaluate_organization_record_access_with_eligibility_internal(jsonb,uuid,jsonb,jsonb)
  to vortex_record_adapter, postgres;
