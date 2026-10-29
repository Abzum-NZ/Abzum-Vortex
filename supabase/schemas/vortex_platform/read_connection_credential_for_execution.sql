create or replace function vortex_platform.read_connection_credential_for_execution(p_ticket uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  ticket_row vortex_platform.connection_execution_tickets%rowtype;
  context_value jsonb;
  credential text;
begin
  context_value := vortex_access.validated_human_request_context();
  update vortex_platform.connection_execution_tickets as ticket
  set credential_read_at = pg_catalog.clock_timestamp()
  where ticket.ticket_id = p_ticket
    and ticket.organization_id = (context_value ->> 'organizationId')::uuid
    and ticket.account_id = (context_value ->> 'organizationAccountId')::uuid
    and ticket.correlation_id = (context_value ->> 'correlationId')::uuid
    and ticket.expires_at > pg_catalog.clock_timestamp()
    and ticket.credential_read_at is null and ticket.completed_at is null
  returning ticket.* into ticket_row;
  if not found then raise exception using errcode = '42501', message = 'Connection execution is unavailable'; end if;
  select secret.decrypted_secret into strict credential
  from vortex_platform.connection_instances as conn
  join vortex_platform.connection_secret_references as reference
    on reference.organization_id = conn.organization_id
    and reference.connection_instance_id = conn.connection_instance_id
    and reference.claimed_at is not null
  join vault.decrypted_secrets as secret on secret.id = reference.vault_secret_id
  where conn.organization_id = ticket_row.organization_id
    and conn.connection_instance_id = ticket_row.connection_instance_id
    and conn.revision = ticket_row.instance_revision and conn.state <> 'revoked';
  return credential;
end
$function$;

revoke all on function vortex_platform.read_connection_credential_for_execution(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_connection_credential_for_execution(uuid) to vortex_runtime;
alter function vortex_platform.read_connection_credential_for_execution(uuid) owner to vortex_owner;
