create or replace function vortex_record.record_change_total_closure_internal(
  p_catalogue jsonb,
  p_roots jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  root_value jsonb;
  closure_value jsonb;
  record_value jsonb;
  signature_value jsonb;
  identity_keys jsonb := '{}'::jsonb;
  record_keys text[] := array[]::text[];
  record_values jsonb[] := array[]::jsonb[];
  record_positions jsonb := '{}'::jsonb;
  record_entry jsonb;
  signatures jsonb := '[]'::jsonb;
  root_key text;
  record_key text;
  source_key text;
  target_key text;
  group_key text;
  group_records jsonb := '{}'::jsonb;
  group_record_map jsonb;
begin
  if pg_catalog.jsonb_typeof(p_roots) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record calculation roots are invalid';
  end if;
  -- Explicit roots keep their caller-assigned keys even when another root's
  -- closure reaches them first. Concrete parents otherwise use their identity.
  for root_value in select item.value from pg_catalog.jsonb_array_elements(p_roots) as item(value)
  loop
    root_key := root_value ->> 'recordKey';
    if root_key is null or root_key = '' or root_value ->> 'operation' is null
      or root_value ->> 'operation' not in ('create', 'update')
      or pg_catalog.jsonb_typeof(root_value -> 'values') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Record calculation root is invalid';
    end if;
    if root_value ->> 'operation' = 'update' then
      record_key := (root_value ->> 'recordTypeId')::uuid::text || ':' ||
        (root_value ->> 'recordId')::uuid::text;
      if identity_keys ? record_key then
        raise exception using errcode = '22023', message = 'Record calculation root is repeated';
      end if;
      identity_keys := identity_keys || pg_catalog.jsonb_build_object(record_key, root_key);
    end if;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_roots) as item(value)
    group by item.value ->> 'recordKey' having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Record calculation key is repeated';
  end if;
  for root_value in
    select item.value from pg_catalog.jsonb_array_elements(p_roots) as item(value)
    order by item.value ->> 'recordKey'
  loop
    root_key := root_value ->> 'recordKey';
    -- Each traversal retains the existing 256-record per-root bound. Do not
    -- skip a root already reached elsewhere: its proposed links can differ.
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, root_value ->> 'operation', (root_value ->> 'recordTypeId')::uuid,
      (root_value ->> 'recordId')::uuid, root_value -> 'values'
    );
    if closure_value is null then return null; end if;
    for record_value in
      select item.value from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
    loop
      record_key := case when record_value ->> 'recordKey' = 'root' then root_key
        else coalesce(identity_keys ->> (record_value ->> 'recordKey'), record_value ->> 'recordKey') end;
      record_entry := record_value || pg_catalog.jsonb_build_object('recordKey', record_key);
      if record_positions ? record_key then
        record_values[(record_positions ->> record_key)::integer] := record_entry;
      else
        record_keys := pg_catalog.array_append(record_keys, record_key);
        record_values := pg_catalog.array_append(record_values, record_entry);
        record_positions := record_positions || pg_catalog.jsonb_build_object(
          record_key, pg_catalog.cardinality(record_keys));
      end if;
      -- A lifecycle root can seed several changed descendants. Its bound is
      -- over their combined transitive closure, not separately per descendant.
      for group_key in select item.value from pg_catalog.jsonb_array_elements_text(
        coalesce(root_value -> 'groupKeys', pg_catalog.jsonb_build_array(root_key))
      ) as item(value)
      loop
        group_record_map := coalesce(group_records -> group_key, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(record_key, true);
        if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(group_record_map)) > 256 then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'record_change_too_large',
            'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 256
          );
        end if;
        group_records := group_records || pg_catalog.jsonb_build_object(group_key, group_record_map);
      end loop;
    end loop;
    if pg_catalog.cardinality(record_keys) > 1000 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_change_too_large',
        'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 1000
      );
    end if;
    for signature_value in
      select item.value from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    loop
      source_key := signature_value ->> 'from';
      target_key := signature_value ->> 'to';
      signatures := signatures || pg_catalog.jsonb_build_array(signature_value || pg_catalog.jsonb_build_object(
        'from', case when source_key = 'root' then root_key else coalesce(identity_keys ->> source_key, source_key) end,
        'to', case when target_key = 'root' then root_key else coalesce(identity_keys ->> target_key, target_key) end
      ));
    end loop;
  end loop;
  return pg_catalog.jsonb_build_object(
    'records', coalesce((select pg_catalog.jsonb_agg(record_values[item.position] order by record_keys[item.position])
      from pg_catalog.generate_subscripts(record_keys, 1) as item(position)), '[]'::jsonb),
    'recordCount', pg_catalog.cardinality(record_keys),
    'signatures', coalesce((select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)), '[]'::jsonb)
  );
exception
  when statement_too_complex then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_change_too_large',
      'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 256
    );
end
$function$;
alter function vortex_record.record_change_total_closure_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_change_total_closure_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_change_total_closure_internal(jsonb,jsonb) is
  'Private dependency discovery for a complete record command, preserving explicit root keys, deduplicating shared parents, and refusing beyond 256 records per root or 1000 records in the union.';
