set local role vortex_record_adapter;
grant execute on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) to vortex_owner;
reset role;

set local role vortex_owner;

create or replace function vortex_platform.complete_flow_segment(
  p_run_id uuid, p_command_id uuid, p_effects jsonb, p_receipt jsonb
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  effect record;
begin
  if p_effects is null or pg_catalog.jsonb_typeof(p_effects) <> 'array' then
    raise exception using errcode = '22023', message = 'Flow segment effects are invalid';
  end if;
  for effect in
    select * from pg_catalog.jsonb_to_recordset(p_effects)
      as entry("taskPath" text, iteration text, outcome text, outputs jsonb)
  loop
    perform vortex_platform.record_flow_segment_effect(
      p_run_id, effect."taskPath", effect.iteration, effect.outcome, effect.outputs
    );
  end loop;
  perform vortex_record.complete_flow_segment_receipt(p_command_id, p_receipt);
end
$function$;

alter function vortex_platform.complete_flow_segment(uuid, uuid, jsonb, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.complete_flow_segment(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.complete_flow_segment(uuid, uuid, jsonb, jsonb)
  to vortex_request, postgres;
comment on function vortex_platform.complete_flow_segment(uuid, uuid, jsonb, jsonb) is
  'Records the admitted segment effects and completes its current human receipt atomically.';

reset role;
