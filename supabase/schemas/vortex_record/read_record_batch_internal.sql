create or replace function vortex_record.read_record_batch_internal(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_preview boolean,
  p_storage_contract_id uuid,
  p_record_type_item jsonb
)
returns table (record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  batch_size constant integer := 201;
  record_count integer := coalesce(pg_catalog.cardinality(p_record_ids), 0);
  record_position integer;
  current_id uuid;
  page_shared jsonb;
  page_first_loaded jsonb;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_narrowed boolean;
  page_batching boolean := true;
  validated_record_types jsonb;
  lookahead_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  read_row record;
begin
  -- The readable projection of every listed record, as read_record gives it, with the page's
  -- installation, access plan, eligibility and envelope loaded once from the first record and
  -- every record decided together, one set pass per batch, as a page read decides its rows.
  for record_position in 1..record_count loop
    current_id := p_record_ids[record_position];
    page_access_loaded := null;
    if record_position = 1 then
      page_shared := pg_catalog.jsonb_build_object(
        'installation', case when p_preview
          then vortex_record.read_current_preview_installation_internal()
          else vortex_definition.read_current_active_installation() end);
      page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
        vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
      page_access_loaded := vortex_record.load_record_access_facts_with_plan_internal(
        p_record_type_id, 'read', current_id, null,
        page_shared -> 'installation', page_shared -> 'plan', null
      );
      if page_access_loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
        page_declaration := page_access_loaded -> 'declaration';
        if p_preview then
          page_shared := page_shared || pg_catalog.jsonb_build_object(
            'previewBounds', vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, p_storage_contract_id, p_record_type_item));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        page_first_loaded := page_access_loaded;
        select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
          page.narrowed
        into page_shared, page_narrowed
        from vortex_record.read_record_page_envelope_internal(p_record_type_id, page_first_loaded) as page;
      end if;
    end if;
    if page_batching and page_first_loaded is not null and not (current_id = any (decided_ids)) then
      lookahead_ids := p_record_ids[record_position:least(record_position + batch_size - 1, record_count)];
      select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
        pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
        pg_catalog.array_agg(decided.bounds)
      into decided_ids, decided_loaded, decided_decisions, decided_bounds
      from vortex_record.read_record_page_decisions_internal(
        p_record_type_id, page_first_loaded, page_declaration, page_eligibility,
        lookahead_ids, page_shared -> 'envelope', page_narrowed
      ) as decided;
      page_batching := pg_catalog.cardinality(decided_ids) > 0;
    end if;
    -- The first record keeps the exact decision, which also validates the installation-wide
    -- facts every decided record shares.
    decided_index := case when record_position > 1
      then pg_catalog.array_position(decided_ids, current_id) end;
    select row_read.* into read_row
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, current_id, page_declaration, page_eligibility,
      validated_record_types, null,
      coalesce(decided_loaded[decided_index], page_access_loaded),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_read;
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        read_row.read_facts -> 'validatedRecordTypes',
        case when read_row.projection ->> 'outcome' = 'allowed'
          then read_row.read_facts #> '{facts,recordTypes}' end
      );
    end if;
    record_id := current_id;
    result := read_row.projection;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) to vortex_owner;

comment on function vortex_record.read_record_batch_internal(uuid,uuid[],boolean,uuid,jsonb) is
  'Private batch record read for owner-side aggregation: returns each listed record''s readable projection exactly as read_record gives it, loading the installation, access plan, eligibility and page envelope once from the first record and deciding the records together, one set pass per batch of 201, through the page decision the paged query read uses.';
