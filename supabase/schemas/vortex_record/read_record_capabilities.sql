create or replace function vortex_record.read_record_capabilities(
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
  read_loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  readable_field_ids jsonb;
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

  -- The row must be readable under the exact decision read_record applies, over
  -- the same fact loader; an unreadable row has no capabilities to report.
  read_loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null
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
  read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  readable_field_ids := vortex_record.project_derived_readable_field_ids_internal(
    read_loaded, p_record_type_id, p_record_id,
    read_bounds -> 'readableFieldIds', read_bounds -> 'readableFieldIds', '[]'::jsonb
  );

  -- Each record action kind is decided exactly as its own writer decides it: the
  -- same fact loader for that action kind and the same complete exact-record
  -- evaluation. An action is reported only when its own decision allows this
  -- exact record; a missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, action_kind, p_record_id, null
    );
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      action_decision := vortex_access.evaluate_organization_record_access_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts'
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                vortex_access.resolve_record_field_bounds_internal(action_decision)
                  -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

revoke all on function vortex_record.read_record_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_capabilities(uuid, uuid) is
  'Fixed record capabilities adapter: for one record readable under the caller''s own current authority, the record action kinds update, delete and restore whose own exact-record decisions allow it, and the fields the update decision lets the caller change, narrowed to the fields read_record projects; returns null for a missing, foreign or unreadable record, identically.';
