create or replace function vortex_record.read_record_with_action_previews(
  p_record_type_id uuid,
  p_record_id uuid,
  p_actions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
  action_item jsonb;
  previews jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_actions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_actions) > 20
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_actions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  -- One exact read decision for the page subject: the projection and the
  -- capabilities vortex_record.read_record_with_capabilities returns, and the
  -- read facts every bound action's preview reuses where they are exactly the
  -- facts its named loader would build. Each action is still decided against
  -- its own declaration; a subject the viewer cannot read previews nothing.
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  if read_row.projection ->> 'outcome' = 'allowed' then
    for action_item in
      select item.value from pg_catalog.jsonb_array_elements(p_actions) with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      previews := previews || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'actionId', action_item -> 'actionId',
        'preview', vortex_record.prepare_named_action_set_announce_internal(
          true, (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
          (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
          (action_item ->> 'actionId')::uuid, p_record_type_id, p_record_id,
          (read_row.projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
          (action_item ->> 'activityId')::uuid, read_row.read_facts
        )
      ));
    end loop;
  end if;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds
      ) end,
    'previews', previews
  );
end
$function$;

alter function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb) to vortex_runtime;

comment on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb) is
  'Fixed record adapter for a page subject and the named actions its placements are bound to: from one read decision under the caller''s current authority, the readable projection (record) and capabilities vortex_record.read_record_with_capabilities returns, and, only when the record is readable, each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), writing nothing.';
