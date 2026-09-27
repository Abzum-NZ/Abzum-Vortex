create or replace function vortex_connection.validated_administration_context(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  ctx_org_id uuid;
begin
  ctx := vortex_context.validated_service_context();
  if ctx ->> 'callerKind' = 'human' then
    perform vortex_connection.assert_connection_administration_authority(ctx);
  end if;
  ctx_org_id := (ctx ->> 'organizationId')::uuid;

  if ctx_org_id is distinct from p_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Connection operation organization does not match request context organization';
  end if;

  return ctx;
end;
$function$;

revoke all on function vortex_connection.validated_administration_context(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_connection.validated_administration_context(uuid) is
  'Returns a matching validated system context or a matching human context with connection administration authority.';
