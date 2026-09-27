create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, proposed_facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);

  -- The write: the typed columns, the next concurrency number, and the change
  -- stamp from the verified context and the installed binding. Owner columns
  -- and lifecycle state are not writable here.
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ', '),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

alter function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) owner to vortex_record_adapter;

revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed record change adapter: locks the row, refuses a stale concurrency number, decides the update on the old and the proposed row, enforces the changeable-field bound over the submitted fields next to the write, and returns the readable projection. Owner-only; #47''s fixed save writer is its caller.';
