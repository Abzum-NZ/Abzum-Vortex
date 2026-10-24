create or replace function vortex_record.prepare_flow_record_update(
  p_record_type_id uuid,
  p_record_id uuid,
  p_module_root_id uuid,
  p_installation_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  field_ids jsonb;
  read_outcome text;
begin
  -- The durable actor resolver establishes this person's fresh application context.
  -- The current installation must still be the exact release retained by the run.
  installation := vortex_definition.read_current_active_installation();
  if installation ? 'previewInstallationId'
    or (installation ->> 'applicationReleaseRevision')::bigint
      is distinct from p_installation_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
  if meta ->> 'moduleRootId' is distinct from p_module_root_id::text
    or meta #>> '{recordType,recordTypeId}' is distinct from p_record_type_id::text then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- No expected revision here: preparation does not lock the record ahead of the
  -- ordinary save's relationship closure. The save owns its locks and revision check.
  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, null, null
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- A replay is still a result handed to the current person. Require the ordinary
  -- read decision too, projecting no field values into this preparation result.
  select row_read.projection ->> 'outcome' into read_outcome
  from vortex_record.read_record_projection_internal(
    p_record_type_id, p_record_id, '[]'::jsonb
  ) as row_read;
  if read_outcome is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  select pg_catalog.jsonb_object_agg(mapping.name, mapping.field_id)
  into field_ids
  from pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
  cross join lateral (values
    (pg_catalog.lower(field.value ->> 'key'), field.value ->> 'fieldId'),
    (pg_catalog.lower(field.value ->> 'fieldId'), field.value ->> 'fieldId')
  ) as mapping(name, field_id)
  where bounds -> 'changeableFieldIds' @> pg_catalog.jsonb_build_array(mapping.field_id);
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'fieldIds', coalesce(field_ids, '{}'::jsonb)
  );
end
$function$;

alter function vortex_record.prepare_flow_record_update(uuid, uuid, uuid, bigint)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_flow_record_update(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.prepare_flow_record_update(uuid, uuid, uuid, bigint)
  to vortex_request;
comment on function vortex_record.prepare_flow_record_update(uuid, uuid, uuid, bigint) is
  'Resolves the current writable record revision and changeable field identities for one published durable update under its initiating person; the ordinary record save rechecks all write permissions and the revision.';
