create or replace function vortex_record.decide_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bounds jsonb;
  record_type_id_value uuid;
  preview_installation jsonb;
  plan jsonb;
  readable_ids jsonb;
begin
  -- The one field-read decision for an exact record: the field policy of the
  -- contributions the access decision matched, then the rule for produced
  -- fields. Every reader of record values takes its readable fields here.
  bounds := vortex_access.resolve_record_field_bounds_internal(p_decision);
  if not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,recordTypeId}', 'uuid') then
    raise exception using errcode = '22023',
      message = 'Record field bounds require a record binding';
  end if;
  record_type_id_value := (p_decision #>> '{recordBinding,recordTypeId}')::uuid;

  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;
  plan := vortex_record.resolve_installation_access_plan_internal(
    coalesce(preview_installation, vortex_definition.read_current_active_installation())
  );
  if (plan ->> 'organizationId')::uuid is distinct from (p_decision ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  readable_ids := vortex_record.decide_produced_field_ids_internal(
    plan, record_type_id_value, bounds -> 'readableFieldIds', '[]'::jsonb
  );
  -- Changeable never exceeds readable.
  return pg_catalog.jsonb_build_object(
    'readableFieldIds', readable_ids,
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds')
        with ordinality as item(value, ordinality)
      where readable_ids @> pg_catalog.jsonb_build_array(item.value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.decide_record_field_bounds_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.decide_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.decide_record_field_bounds_internal(jsonb) is
  'Private field-read decision over one allowed exact-record access decision: the readable and changeable fields of the matched contributions'' field policies, with every calculation and total the reader may not fully read withheld so that every reader shows it as Restricted.';
