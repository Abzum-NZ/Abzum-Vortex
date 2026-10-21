-- #3304: row-action previews of a grid page cost one page read.

set local role vortex_record_adapter;

create or replace function vortex_record.read_records_with_action_previews(
  p_record_type_id uuid,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_ids uuid[];
  requested_id uuid;
  target_position integer;
  action_item jsonb;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[] := array[]::jsonb[];
  decided_decisions jsonb[] := array[]::jsonb[];
  decided_bounds jsonb[] := array[]::jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  read_facts jsonb;
  preview_meta jsonb;
  preview_installation_id uuid;
  previews jsonb[];
  results jsonb[] := array[]::jsonb[];
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(target.value ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(target.value -> 'actions') is distinct from 'array'
        or pg_catalog.jsonb_array_length(target.value -> 'actions') > 20
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(target.value -> 'actions') as item(value)
          where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint'), false)
        )
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  select coalesce(pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    array[]::uuid[])
  into target_ids
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);

  -- The page read pass the list read uses (#2668): the first readable record
  -- is decided exactly and supplies the installation-wide facts; the other
  -- records are decided together from them. A record the pass does not decide
  -- (missing, inaccessible or relationship-routed) keeps the exact
  -- single-record path with the same refusal. The eligibility is local to this
  -- invocation and narrows work only when each record's projection confirms
  -- the same declaration and a live deadline.
  if p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array target_ids loop
      if requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', requested_id, null, null::jsonb
      );
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        page_declaration := loaded -> 'declaration';
        if loaded ? 'previewInstallationId' then
          preview_installation_id := (loaded ->> 'previewInstallationId')::uuid;
          preview_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
          page_shared := pg_catalog.jsonb_build_object('previewBounds',
            vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
              preview_meta -> 'recordType'));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;
  if first_loaded is not null then
    select pg_catalog.array_agg(distinct candidate.id)
    into candidate_ids
    from pg_catalog.unnest(target_ids) as candidate(id)
    where candidate.id <> first_loaded_id
      and candidate.id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end if;
  if candidate_ids is not null then
    select coalesce(page_shared, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
      page.narrowed
    into page_shared, page_narrowed
    from vortex_record.read_record_page_envelope_internal(p_record_type_id, first_loaded) as page;
    -- At most 199 candidates (200 targets, the first decided exactly).
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
    into decided_ids, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, first_loaded, page_declaration, page_eligibility,
      candidate_ids, page_shared -> 'envelope', page_narrowed
    ) as decided;
  end if;

  for target_position in 1 .. pg_catalog.cardinality(target_ids) loop
    requested_id := target_ids[target_position];
    decided_index := case when requested_id is distinct from first_loaded_id
      then pg_catalog.array_position(decided_ids, requested_id) end;
    select row_projection.* into row_read
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, requested_id, page_declaration, page_eligibility,
      validated_record_types, null::jsonb,
      coalesce(decided_loaded[decided_index],
        case when requested_id = first_loaded_id then first_loaded end),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_projection;
    if requested_id = first_loaded_id then
      first_loaded := null;
    end if;
    projection := row_read.projection;
    -- Only the exact evaluator validates record types for reuse.
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        row_read.read_facts -> 'validatedRecordTypes',
        case when projection ->> 'outcome' = 'allowed'
          then row_read.read_facts #> '{facts,recordTypes}' end
      );
    end if;
    previews := array[]::jsonb[];
    if projection ->> 'outcome' = 'allowed' then
      -- A decided record carries its compact scope; its complete read facts are
      -- the page envelope with that scope. Each bound action is still decided
      -- against its own declaration, never by the record's read decision.
      read_facts := case when decided_index is not null
        then vortex_record.read_record_page_row_facts_internal(page_shared -> 'envelope', row_read.read_facts)
        else row_read.read_facts end;
      for action_item in
        select item.value
        from pg_catalog.jsonb_array_elements(p_targets -> (target_position - 1) -> 'actions')
          with ordinality as item(value, ordinality)
        order by item.ordinality
      loop
        previews := pg_catalog.array_append(previews, pg_catalog.jsonb_build_object(
          'actionId', action_item -> 'actionId',
          'preview', vortex_record.prepare_named_action_set_announce_internal(
            true, (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
            (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
            (action_item ->> 'actionId')::uuid, p_record_type_id, requested_id,
            (projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
            (action_item ->> 'activityId')::uuid, read_facts
          )
        ));
      end loop;
    end if;
    results := pg_catalog.array_append(results, pg_catalog.jsonb_build_object(
      'recordId', requested_id,
      'record', case when projection ->> 'outcome' = 'allowed'
        then pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', projection -> 'recordId',
          'concurrencyNumber', projection -> 'concurrencyNumber')
        else projection end,
      'previews', pg_catalog.to_jsonb(previews)
    ));
  end loop;
  -- PL/pgSQL materializes the result before returning it. Revalidate after all
  -- reads so invocation-local preview facts cannot extend a builder's expiring
  -- role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview authority is unavailable';
  end if;
  return pg_catalog.to_jsonb(results);
end
$function$;

alter function vortex_record.read_records_with_action_previews(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_records_with_action_previews(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_records_with_action_previews(uuid, jsonb) to vortex_runtime;

comment on function vortex_record.read_records_with_action_previews(uuid, jsonb) is
  'Fixed record adapter for a grid page of records and the named actions bound to each: reads every target through the page read pass the list read uses (the first readable record decided exactly, the others together, any record the pass does not decide by the exact single-record path), and, only for a readable record, returns each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), under the caller''s current authority and writing nothing; a readable record is reported by its recordId and concurrencyNumber, an unreadable one as refused.';

reset role;
