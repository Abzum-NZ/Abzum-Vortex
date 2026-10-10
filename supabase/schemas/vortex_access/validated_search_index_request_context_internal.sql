create or replace function vortex_access.validated_search_index_request_context_internal(p_occurrence_id uuid, p_claim_cursor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  resolved jsonb;
  observed_at timestamptz;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'system'
    or checked ->> 'channel' is distinct from 'system'
    or checked ? 'supportContext'
    or not checked ?& array['systemActorId','tenantId','organizationId','applicationRootId',
      'accessVersion','issuedAt','expiresAt'] then
    raise exception using errcode = '42501', message = 'Search purpose context is unavailable';
  end if;
  resolved := vortex_access.read_search_index_actor_scope_internal(p_occurrence_id,p_claim_cursor);
  observed_at := pg_catalog.clock_timestamp();
  if checked ->> 'systemActorId' is distinct from resolved ->> 'systemActorId'
    or checked ->> 'tenantId' is distinct from resolved ->> 'tenantId'
    or checked ->> 'organizationId' is distinct from resolved ->> 'organizationId'
    or checked ->> 'applicationRootId' is distinct from resolved ->> 'applicationRootId'
    or (checked ->> 'accessVersion')::bigint is distinct from (resolved ->> 'accessVersion')::bigint
    or (checked ->> 'issuedAt')::timestamptz > observed_at
    or (checked ->> 'expiresAt')::timestamptz <= observed_at
    or (checked ->> 'expiresAt')::timestamptz > (resolved ->> 'leaseExpiresAt')::timestamptz then
    raise exception using errcode = '42501', message = 'Search purpose context is unavailable';
  end if;
  return resolved;
end
$function$;
alter function vortex_access.validated_search_index_request_context_internal(uuid,uuid) owner to vortex_access_owner;
revoke all on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner, vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) to vortex_module_owner, vortex_search_owner, vortex_record_adapter;
comment on function vortex_access.validated_search_index_request_context_internal(uuid,uuid) is 'Owner-only current SYSTEM Search purpose validator over the exact retained source claim and active fixed grant; no caller supplied authority.';
