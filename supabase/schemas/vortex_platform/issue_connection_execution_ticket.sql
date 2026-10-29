create or replace function vortex_platform.issue_connection_execution_ticket(
  p_instance_id uuid, p_expected_revision bigint, p_operation text, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  instance_row vortex_platform.connection_instances%rowtype;
  ticket_id uuid := pg_catalog.gen_random_uuid();
  now_value timestamptz := pg_catalog.clock_timestamp();
  receipt jsonb;
begin
  if p_instance_id is null or p_expected_revision is null or p_command_id is null or p_operation is distinct from 'health_check' then
    raise exception using errcode = '22023', message = 'Connection execution input is invalid';
  end if;
  perform vortex_platform.assert_human_administration_request();
  context_value := vortex_platform.validated_administration_context(vortex_platform.organization_id());
  receipt := vortex_record.claim_scoped_command_receipt_internal(
    'connection_health_check', p_command_id, (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'tenantId')::uuid, (context_value ->> 'organizationAccountId')::uuid,
    'Connection command is unavailable'
  );
  if receipt is not null then return receipt; end if;
  select conn.* into instance_row from vortex_platform.connection_instances as conn
  where conn.organization_id = (context_value ->> 'organizationId')::uuid
    and conn.connection_instance_id = p_instance_id and conn.revision = p_expected_revision
    and conn.state <> 'revoked' and conn.revision < 9007199254740991
  for update;
  if not found then
    receipt := pg_catalog.jsonb_build_object('outcome', 'conflict');
    perform vortex_record.complete_scoped_command_receipt_internal(p_command_id, receipt);
    return receipt;
  end if;
  now_value := pg_catalog.clock_timestamp();
  delete from vortex_platform.connection_execution_tickets where ticket_id in (
    select ticket.ticket_id from vortex_platform.connection_execution_tickets as ticket
    where ticket.expires_at <= now_value order by ticket.expires_at limit 500
  );
  insert into vortex_platform.connection_execution_tickets (
    ticket_id, organization_id, account_id, correlation_id, connection_instance_id, command_id,
    instance_revision, operation, expires_at
  ) values (
    ticket_id, instance_row.organization_id, (context_value ->> 'organizationAccountId')::uuid,
    (context_value ->> 'correlationId')::uuid, p_instance_id, p_command_id, p_expected_revision,
    p_operation, now_value + interval '60 seconds'
  );
  return pg_catalog.jsonb_build_object('outcome', 'available', 'ticket', ticket_id,
    'connectionTypeId', instance_row.connection_type_id,
    'connectionTypeVersion', instance_row.connection_type_version);
end
$function$;

revoke all on function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid) to vortex_request;
alter function vortex_platform.issue_connection_execution_ticket(uuid, bigint, text, uuid) owner to vortex_owner;
