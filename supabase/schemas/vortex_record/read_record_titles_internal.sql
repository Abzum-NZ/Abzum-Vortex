create or replace function vortex_record.read_record_titles_internal(
  p_targets jsonb
)
returns table (record_type_id uuid, record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  target_item jsonb;
  target_type_id uuid;
  target_title_field_id uuid;
  target_record_ids uuid[];
  title_key text;
  context_value jsonb;
  installation jsonb;
  plan jsonb;
  preview_installation jsonb;
  preview_installation_id uuid;
  refused_installation boolean := false;
  requested_id uuid;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  chunk_start integer;
  decided_ids uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  readable_values jsonb;
  preview_meta jsonb;
begin
  if p_targets is null or pg_catalog.jsonb_typeof(p_targets) <> 'array' then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_targets) = 0 then
    return;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') <> 'array'
  ) or (
    select pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  ) <> pg_catalog.jsonb_array_length(p_targets) then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;

  -- The verified request context and the current installation (the explicitly
  -- addressed preview for its owner, otherwise the active installation) are read
  -- once, and the installation access plan is resolved ONCE for the whole call:
  -- every record of every target type below decides against this one plan.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  begin
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null
      and preview_installation ->> 'outcome' = 'refused' then
      refused_installation := true;
    else
      installation := case when preview_installation is null
        then vortex_definition.read_current_active_installation()
        else preview_installation end;
      plan := vortex_record.resolve_installation_access_plan_internal(installation);
      if preview_installation is not null then
        preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
      end if;
    end if;
  exception
    when no_data_found then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    when too_many_rows then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is ambiguous';
  end;

  for target_item in
    select item.value from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  loop
    target_type_id := (target_item ->> 'recordTypeId')::uuid;
    target_title_field_id := (target_item ->> 'titleFieldId')::uuid;
    select coalesce(pg_catalog.array_agg(id.value::uuid order by id.ordinality), array[]::uuid[])
    into target_record_ids
    from pg_catalog.jsonb_array_elements_text(target_item -> 'recordIds')
      with ordinality as id(value, ordinality)
    where id.value is not null;
    title_key := pg_catalog.lower(target_title_field_id::text);
    first_loaded_id := null;
    first_loaded := null;
    page_declaration := null;
    page_eligibility := null;
    page_narrowed := null;
    candidate_ids := null;
    validated_record_types := null;
    decided_ids := array[]::uuid[];
    decided_loaded := array[]::jsonb[];
    decided_decisions := array[]::jsonb[];
    decided_bounds := array[]::jsonb[];
    -- Records the page read pass does not decide use the same installation and plan.
    page_shared := case when refused_installation then null
      else pg_catalog.jsonb_build_object('installation', installation, 'plan', plan) end;

    -- The eligibility is local to this invocation. It narrows work only when the
    -- per-record projection confirms the same declaration and a live deadline.
    if not refused_installation and target_type_id <> nil_uuid then
      foreach requested_id in array target_record_ids loop
        if requested_id = nil_uuid then
          continue;
        end if;
        loaded := vortex_record.load_record_access_facts_with_plan_internal(
          target_type_id, 'read', requested_id, null, installation, plan, null::jsonb
        );
        if loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
          page_declaration := loaded -> 'declaration';
          if loaded ? 'previewInstallationId' then
            preview_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
            page_shared := page_shared || pg_catalog.jsonb_build_object('previewBounds',
              vortex_record.preview_record_field_bounds_internal(
                target_type_id, (preview_meta ->> 'storageContractId')::uuid,
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

    -- The other ids are decided together by the page read pass (#2668), from
    -- the first record's exact facts, in sets of at most 200. The pass returns
    -- only the records it decided; every other id keeps the exact path below.
    if first_loaded is not null then
      select pg_catalog.array_agg(distinct candidate.id)
      into candidate_ids
      from pg_catalog.unnest(target_record_ids) as candidate(id)
      where candidate.id <> nil_uuid and candidate.id <> first_loaded_id;
    end if;
    if candidate_ids is not null then
      select page_shared
        || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
        page.narrowed
      into page_shared, page_narrowed
      from vortex_record.read_record_page_envelope_internal(target_type_id, first_loaded) as page;
      chunk_start := 1;
      while chunk_start <= coalesce(pg_catalog.cardinality(candidate_ids), 0) loop
        select decided_ids || coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          decided_loaded || coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
          decided_decisions || coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
          decided_bounds || coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          target_type_id, first_loaded, page_declaration, page_eligibility,
          candidate_ids[chunk_start:chunk_start + 199], page_shared -> 'envelope', page_narrowed
        ) as decided;
        chunk_start := chunk_start + 200;
      end loop;
    end if;

    foreach requested_id in array target_record_ids loop
      record_type_id := target_type_id;
      record_id := requested_id;
      if refused_installation then
        result := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        continue;
      end if;
      decided_index := case when requested_id is distinct from first_loaded_id
        then pg_catalog.array_position(decided_ids, requested_id) end;
      select row_projection.* into row_read
      from vortex_record.read_record_projection_with_validated_types_internal(
        target_type_id, requested_id, page_declaration, page_eligibility,
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

      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        result := (projection - 'values') || pg_catalog.jsonb_build_object(
          'values', case when readable_values ? title_key
            then pg_catalog.jsonb_build_object(title_key, readable_values -> title_key)
            else '{}'::jsonb end
        );
      else
        result := projection;
      end if;
      return next;
    end loop;
  end loop;
  -- PL/pgSQL materializes this set before returning it. Revalidate after all
  -- projections so invocation-local preview facts cannot extend a builder's
  -- expiring role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview title authority is unavailable';
  end if;
end
$function$;

alter function vortex_record.read_record_titles_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_titles_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_titles_internal(jsonb) to vortex_owner;

comment on function vortex_record.read_record_titles_internal(jsonb) is
  'Private adapter batch of record titles for many target record types: the request context, current installation and access plan are resolved once for the whole call; per type the first record is decided exactly, the others together by the page read pass with a local page eligibility, and any record the pass does not decide (missing, inaccessible or relationship-routed) by the exact single-record path with the same refusal.';
