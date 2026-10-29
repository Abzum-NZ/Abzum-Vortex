create or replace function vortex_platform.record_connection_health_result(p_ticket uuid, p_outcome text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  ticket_row vortex_platform.connection_execution_tickets%rowtype;
  context_value jsonb;
  activity_id uuid := pg_catalog.gen_random_uuid();
  now_value timestamptz := pg_catalog.clock_timestamp();
  new_revision bigint;
  activity_result text;
begin
  if p_outcome is null or p_outcome not in ('healthy', 'unhealthy', 'unknown', 'no_adapter') then
    raise exception using errcode = '22023', message = 'Connection health outcome is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  update vortex_platform.connection_execution_tickets as ticket
  set completed_at = now_value
  where ticket.ticket_id = p_ticket and ticket.operation = 'health_check'
    and ticket.organization_id = (context_value ->> 'organizationId')::uuid
    and ticket.account_id = (context_value ->> 'organizationAccountId')::uuid
    and ticket.correlation_id = (context_value ->> 'correlationId')::uuid
    and ticket.expires_at > now_value and ticket.completed_at is null
    and (p_outcome in ('unknown', 'no_adapter') or ticket.credential_read_at is not null)
  returning ticket.* into ticket_row;
  if not found then raise exception using errcode = '42501', message = 'Connection execution is unavailable'; end if;
  update vortex_platform.connection_instances as conn
  set last_health_outcome = case when p_outcome = 'no_adapter' then 'unknown' else p_outcome end,
    state = case p_outcome when 'healthy' then 'active' when 'unhealthy' then 'unhealthy' else 'pending' end,
    revision = conn.revision + 1, updated_at = now_value, administrator_activity_id = activity_id
  where conn.organization_id = ticket_row.organization_id
    and conn.connection_instance_id = ticket_row.connection_instance_id
    and conn.revision = ticket_row.instance_revision and conn.state <> 'revoked'
  returning conn.revision into new_revision;
  if not found then raise exception using errcode = '40001', message = 'Connection execution is stale'; end if;
  activity_result := vortex_record.append_organization_activity_entry(
    ticket_row.organization_id, activity_id, now_value, 'organization_account', ticket_row.account_id,
    'connection_health_check', array[ticket_row.connection_instance_id]::uuid[], array[]::uuid[],
    vortex_platform.channel(), ticket_row.correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Connection health Activity is stale';
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(ticket_row.command_id,
    pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', new_revision, 'healthOutcome', p_outcome));
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', new_revision, 'healthOutcome', p_outcome);
end
$function$;

revoke all on function vortex_platform.record_connection_health_result(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.record_connection_health_result(uuid, text) to vortex_runtime;
alter function vortex_platform.record_connection_health_result(uuid, text) owner to vortex_owner;
