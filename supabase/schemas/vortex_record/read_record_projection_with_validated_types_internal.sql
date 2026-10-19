create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb,
  p_decision jsonb,
  p_bounds jsonb,
  p_page jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  -- The page-wide part of the facts (the envelope) when this record arrives
  -- as a compact record scope; otherwise the record's own complete facts.
  shared jsonb;
  compact boolean;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  field_values jsonb;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
  batched boolean := false;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  -- A page passes the page-wide part of the facts once (p_page.envelope) and
  -- each decided record as its compact record scope; the complete facts are
  -- rebuilt only on the paths that read more than this record's own values.
  compact := p_loaded is not null and p_loaded ? 'record'
    and pg_catalog.jsonb_typeof(p_page -> 'envelope') = 'object';
  if p_loaded is not null and p_loaded ? 'record' and not compact then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  loaded := case when compact then null else p_loaded end;
  if loaded is null and not compact then
    if p_page ? 'installation' then
      -- The active installation this invocation read and validated once.
      loaded := vortex_record.load_record_access_facts_from_installation_internal(
        p_record_type_id, 'read', p_record_id, null, p_page -> 'installation', p_projection_row
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', p_record_id, null, p_projection_row
      );
    end if;
  end if;
  shared := case when compact then p_page -> 'envelope' else loaded end;
  if p_loaded is not null and shared ->> 'outcome' = 'loaded' and (
    shared -> 'facts' -> 'binding' ->> 'recordTypeId' is distinct from
      pg_catalog.lower(p_record_type_id::text)
    or case when compact
      then p_loaded -> 'record' -> 'recordScope' ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text)
      else not exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where item.value -> 'recordScope' ->> 'recordId' = pg_catalog.lower(p_record_id::text)
      ) end
  ) then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  if shared ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(shared -> 'declaration') <> 'object' then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  if shared ? 'previewInstallationId' then
    if p_page -> 'envelope' -> 'previewInstallationId' = shared -> 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_page -> 'previewBounds') = 'object' then
      preview_bounds := p_page -> 'previewBounds';
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      preview_meta := vortex_record.resolve_record_action_context_internal(
        p_record_type_id, 'read'
      );
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
        preview_meta -> 'recordType'
      );
    end if;
    if preview_bounds is null then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      return next;
      return;
    end if;
    bounds := preview_bounds;
  else
    if p_decision is not null then
      -- The page's set pass decided this exact record in this invocation from
      -- these facts; only the fixed record adapter can pass it.
      if p_loaded is null
        or p_decision ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text) then
        raise exception using errcode = '22023', message = 'Page record decision is invalid';
      end if;
      -- It is used only while it is still current now: an allowed decision
      -- whose own deadline (every matched permission path, share and group
      -- membership) and the page eligibility are both still in the future.
      -- Anything else is decided again exactly, at this row's own time.
      batched := coalesce(p_decision ->> 'outcome' = 'allowed'
        and (p_decision ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp()
        and p_page_eligibility ->> 'outcome' = 'eligible'
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp(), false);
    end if;
    if batched then
      decision := p_decision;
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      if p_page_eligibility ->> 'outcome' = 'eligible'
        and loaded -> 'declaration' = p_page_declaration
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        decision := vortex_access.evaluate_record_access_with_validated_types_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts', p_page_eligibility,
          p_validated_record_types
        );
      else
        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts'
        );
      end if;
    end if;
    if decision ->> 'outcome' <> 'allowed' then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      -- A decision, even a refusal, means the record types passed validation;
      -- the page reuses them. Callers read read_facts only for allowed rows.
      read_facts := pg_catalog.jsonb_build_object(
        'validatedRecordTypes', shared -> 'facts' -> 'recordTypes'
      );
      return next;
      return;
    end if;
    bounds := coalesce(case when batched then p_bounds end,
      vortex_record.decide_record_field_bounds_internal(decision));
  end if;
  field_values := case when compact then p_loaded -> 'record' -> 'fieldValues'
    else loaded -> 'fieldValues' end;
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage. A page works out the record type's read-time
  -- fields and the statement's clock once and passes them here.
  if compact and p_page ? 'readTimeFields' then
    read_time_fields := p_page -> 'readTimeFields';
  else
    select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
    into read_time_fields
    from pg_catalog.jsonb_array_elements(shared -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'calculation'
      and (field.value #>> '{settings,evaluation}' = 'read_time'
        or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  end if;
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := case when compact and p_page ? 'readTimeClock' then p_page -> 'readTimeClock'
      else vortex_record.read_time_clock_internal() end;
  end if;
  if read_time_fields = '{}'::jsonb then
    -- Without read-time fields every readable stored value is projected as
    -- stored: one statement instead of one step per field.
    select coalesce(pg_catalog.jsonb_object_agg(item.value #>> '{}', field_values -> (item.value #>> '{}')
        order by item.ordinality), '{}'::jsonb)
    into values_value
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') with ordinality as item(value, ordinality)
    where shared -> 'columns' ? (item.value #>> '{}');
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
    where read_time_fields <> '{}'::jsonb
  loop
    if not (shared -> 'columns' ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := field_values -> due_key;
      status_value := case when status_key is null then null else field_values -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, field_values -> field_id);
    end if;
  end loop;
  projection := pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', case when compact then p_loaded -> 'concurrencyNumber'
      else loaded -> 'concurrencyNumber' end,
    'values', values_value);
  -- A compact record keeps its compact scope; the caller holds the envelope.
  read_facts := case when compact then p_loaded else loaded end;
  read_bounds := bounds;
  return next;
end
$function$;

alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;
