create or replace function vortex_record.flow_segment_receipt(
  p_command_id uuid, p_replay_only boolean
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  classified jsonb;
  stored_result jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_replay_only is null then
    raise exception using errcode = '22023', message = 'Flow segment command is invalid';
  end if;
  classified := vortex_record.claim_command_receipt_internal(
    'flow_segment', p_command_id, p_replay_only
  );
  if classified ->> 'status' <> 'completed' then
    return classified;
  end if;
  -- The classifier has checked the current organisation, tenant and actor before this read.
  select receipt.result into strict stored_result
  from vortex_record.command_receipts as receipt
  where receipt.command_id = p_command_id;
  return pg_catalog.jsonb_build_object('status', 'completed', 'result', stored_result);
end
$function$;

alter function vortex_record.flow_segment_receipt(uuid, boolean) owner to vortex_record_adapter;
revoke all on function vortex_record.flow_segment_receipt(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.flow_segment_receipt(uuid, boolean) to vortex_request, postgres;
comment on function vortex_record.flow_segment_receipt(uuid, boolean) is
  'Looks up or claims a flow segment command in the current human request scope.';
