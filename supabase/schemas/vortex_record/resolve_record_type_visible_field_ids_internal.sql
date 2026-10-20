create or replace function vortex_record.resolve_record_type_visible_field_ids_internal(
  p_record_type_id uuid, p_installation jsonb, p_plan jsonb,
  p_declaration jsonb, p_eligibility jsonb, p_possible_field_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  meta jsonb := p_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  routes record;
  candidate record;
  candidate_ids uuid[];
  candidate_id uuid;
  after_id uuid;
  projection_rows jsonb;
  projection_row jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  bounds_key text;
  bounds_by_contribution jsonb := '{}'::jsonb;
  visible jsonb := '[]'::jsonb;
  scan_sql text;
begin
  -- Only the owning wrapper supplies this local decision. No GUC, temporary
  -- table or request argument can supply or retain an access decision.
  if p_eligibility ->> 'outcome' is distinct from 'eligible' then
    return visible;
  end if;
  select resolved.* into routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    p_declaration, meta ->> 'ownershipMode'
  ) as resolved;
  scan_sql := pg_catalog.format(
    'select stored.record_id from record_data.%I as stored
     where stored.organisation_id = $1 and stored.lifecycle_state = ''active''
       and ($2::uuid is null or stored.record_id > $2)
       and (%L <> ''application_contained'' or stored.application_root_id = $3)
       and (not $4 or stored.owner_organisation_account_id = $5
         or stored.owner_group_id = any($6) or stored.record_id = any($7))
     order by stored.record_id limit 40', meta ->> 'table', meta ->> 'storageScope'
  );
  loop
    candidate_ids := '{}'::uuid[];
    projection_rows := '{}'::jsonb;
    if (meta ->> 'isSystemProjection')::boolean then
      -- Protected read models keep their existing bounded reader, never a
      -- scan of the composite view. Only access facts are consumed below.
      for candidate in
        select projected.* from vortex_record.read_system_projection_rows_internal(
          (meta ->> 'storageContractId')::uuid, null, 'record_id', 'ascending',
          case when after_id is null then null else
            pg_catalog.jsonb_build_object('recordId', after_id) end, 40
        ) as projected
      loop
        candidate_ids := pg_catalog.array_append(candidate_ids, candidate.record_id);
        projection_rows := projection_rows || pg_catalog.jsonb_build_object(
          candidate.record_id::text, pg_catalog.to_jsonb(candidate));
      end loop;
    else
      for candidate in execute scan_sql using (ctx ->> 'organizationId')::uuid,
        after_id, (ctx ->> 'applicationRootId')::uuid, routes.restricted,
        routes.owner_account_id, routes.owner_group_ids, routes.shared_record_ids
      loop
        candidate_ids := pg_catalog.array_append(candidate_ids, candidate.record_id);
      end loop;
    end if;
    exit when pg_catalog.cardinality(candidate_ids) = 0;
    foreach candidate_id in array candidate_ids loop
      projection_row := projection_rows -> candidate_id::text;
      -- No off-screen field projection: the loader reads only operands
      -- required to decide access, including saved conditions and relations.
      loaded := vortex_record.load_record_access_facts_from_installation_internal(
        p_record_type_id, 'read', candidate_id, null, p_installation,
        projection_row, '[]'::jsonb
      );
      if loaded ->> 'outcome' is distinct from 'loaded' then
        continue;
      end if;
      decision := vortex_access.evaluate_organization_record_access_with_eligibility_internal(
        p_declaration, candidate_id, loaded -> 'facts', p_eligibility
      );
      if decision ->> 'outcome' = 'allowed' then
        bounds_key := (decision -> 'matchedContributions')::text;
        bounds := bounds_by_contribution -> bounds_key;
        if bounds is null then
          bounds := vortex_record.decide_record_field_bounds_internal(decision);
          bounds_by_contribution := bounds_by_contribution
            || pg_catalog.jsonb_build_object(bounds_key, bounds);
        end if;
        select coalesce(pg_catalog.jsonb_agg(ids.value order by ids.value), '[]'::jsonb)
        into visible from (
          select distinct field.value from pg_catalog.jsonb_array_elements(
            visible || (bounds -> 'readableFieldIds')
          ) as field(value)
        ) as ids;
        -- Once every potential field has an exact allowed witness there is
        -- nothing left to learn. There is no arbitrary scan cap that could
        -- hide a field readable only on a later record.
        if visible @> p_possible_field_ids then
          return visible;
        end if;
      end if;
    end loop;
    after_id := candidate_ids[pg_catalog.cardinality(candidate_ids)];
  end loop;
  return visible;
end
$function$;

alter function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_owner;
comment on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid,jsonb,jsonb,jsonb,jsonb,jsonb) is
  'Owner-only existential column policy: unions the existing exact field decisions of current eligible records, including actual share contributions, without projecting off-screen values.';
