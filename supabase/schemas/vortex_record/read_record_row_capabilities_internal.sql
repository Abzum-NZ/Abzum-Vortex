create or replace function vortex_record.read_record_row_capabilities_internal(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  installation jsonb;
  read_loaded jsonb;
  read_decision jsonb;
  bounds jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid then
    return null;
  end if;

  -- The exact active installation is read once and the same private fact loader
  -- caller read_record uses is invoked for read_record's own 'read' action, so
  -- the changeable field identities are the ones the same read decision marks.
  installation := vortex_module.read_current_active_installation();
  read_loaded := vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, 'read', p_record_id, null, installation
  );
  if read_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(read_loaded -> 'declaration') <> 'object' then
    return null;
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    read_loaded -> 'declaration', p_record_id, read_loaded -> 'facts'
  );
  if read_decision ->> 'outcome' <> 'allowed' then
    return null;
  end if;

  -- The changeable field identities are the same read decision's own field
  -- bounds, narrowed to the fields read_record actually projects (derived
  -- calculation identities are withheld there and are never reported here).
  bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  changeable_field_ids := coalesce((
    select pg_catalog.jsonb_agg(candidate.value order by candidate.value)
    from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') as candidate(value)
    where candidate.value in (
      select projected.value
      from pg_catalog.jsonb_array_elements_text(
        vortex_record.project_derived_readable_field_ids_internal(
          read_loaded, p_record_type_id, p_record_id,
          bounds -> 'readableFieldIds', bounds -> 'readableFieldIds', '[]'::jsonb
        )
      ) as projected(value)
    )
  ), '[]'::jsonb);

  -- Each record action kind is the same complete exact-record decision read_record
  -- computes, once for that action kind over the same fact loader. An action is
  -- reported only when its own decision allows this exact record; a missing
  -- declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := vortex_record.load_record_access_facts_from_installation_internal(
      p_record_type_id, action_kind, p_record_id, null, installation
    );
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      action_decision := vortex_access.evaluate_organization_record_access_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts'
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field the same read decision marks
  -- changeable, so update is never reported without one.
  if 'update' = any (actions)
    and pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

revoke all on function vortex_record.read_record_row_capabilities_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.read_record_row_capabilities_internal(uuid, uuid) is
  'Private per-row list capabilities: the changeable field identities of the same read decision read_record applies, plus the record action kinds update, delete and restore whose own complete exact-record decisions allow this exact record; returns null when the record is not readable, so a row is never exposed without its capabilities; owner-only.';
