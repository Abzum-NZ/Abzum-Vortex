create or replace function vortex_record.read_record_titles_internal(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_title_field_id uuid
)
returns table (record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  requested_id uuid;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  readable_values jsonb;
  title_key text := pg_catalog.lower(p_title_field_id::text);
begin
  if p_record_ids is null then
    return;
  end if;

  -- The eligibility is local to this invocation. It narrows work only when the
  -- per-record projection confirms the same declaration and a live deadline.
  if p_record_type_id is not null
    and p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array p_record_ids loop
      if requested_id is null
        or requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', requested_id, null
      );
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object'
        and not (loaded ? 'previewInstallationId') then
        page_declaration := loaded -> 'declaration';
        page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
          page_declaration, vortex_access.validated_human_request_context(),
          pg_catalog.clock_timestamp()
        );
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;

  foreach requested_id in array p_record_ids loop
    select row_projection.* into row_read
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, requested_id, page_declaration, page_eligibility,
      validated_record_types, null::jsonb,
      case when requested_id = first_loaded_id then first_loaded else null::jsonb end
    ) as row_projection;
    if requested_id = first_loaded_id then
      first_loaded := null;
    end if;
    projection := row_read.projection;
    if validated_record_types is null then
      validated_record_types := coalesce(
        row_read.read_facts -> 'validatedRecordTypes',
        case when projection ->> 'outcome' = 'allowed'
          then row_read.read_facts #> '{facts,recordTypes}' end
      );
    end if;

    record_id := requested_id;
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
end
$function$;

alter function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) to vortex_owner;

comment on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) is
  'Private adapter batch of exact-record projections with a local page eligibility and the same refusal for missing or inaccessible records.';
