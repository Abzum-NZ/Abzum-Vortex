CREATE FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  max_groups constant integer := 100;
  max_records constant integer := 1000;
  conflict_sql text;
  group_row record;
  record_id_value uuid;
  loaded jsonb;
  decision jsonb;
  readable_references jsonb := '[]'::jsonb;
  group_count integer := 0;
  record_count integer := 0;
begin
  if p_record_type_id is null
    or p_record_type_id = nil_uuid
    or p_table_token is null
    or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null
    or p_column_token !~ '^f_[a-f0-9]{32}$'
    or p_scope_columns is null
    or p_scope_columns not in ('organisation_id', 'organisation_id, application_root_id') then
    raise exception using errcode = '55000',
      message = 'Index conflict selector is invalid';
  end if;

  -- Only the participating record identities are selected; the conflicting
  -- field value is grouped on but never projected, so no raw value can leave.
  -- The search mirrors the unique index exactly: its lifecycle predicate, and
  -- no null value, because the index treats every null as distinct. The
  -- forced `record_data` policies keep it to the caller's organisation and
  -- Application.
  conflict_sql := pg_catalog.format(
    'select pg_catalog.array_agg(stored.record_id order by stored.record_id) as record_ids
     from record_data.%I as stored
     where stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
       and stored.%I is not null
     group by %s, stored.%I
     having pg_catalog.count(*) > 1
     order by 1
     limit %s',
    p_table_token, p_column_token, p_scope_columns, p_column_token, max_groups + 1
  );

  for group_row in execute conflict_sql
  loop
    group_count := group_count + 1;
    if group_count > max_groups then
      return pg_catalog.jsonb_build_object('outcome', 'unreadable');
    end if;

    for record_id_value in
      select id.value from pg_catalog.unnest(group_row.record_ids) as id(value)
    loop
      record_count := record_count + 1;
      if record_count > max_records then
        return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end if;

      begin
        loaded := vortex_record.load_record_access_facts_internal(
          p_record_type_id, 'read', record_id_value, null
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object'
          or pg_catalog.jsonb_typeof(loaded -> 'facts') <> 'object' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', record_id_value, loaded -> 'facts'
        );
        -- Any unreadable participant collapses the whole conflict; a partial
        -- listing would be an existence oracle for the hidden rows.
        if decision ->> 'outcome' <> 'allowed' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;
      exception
        when others then
          -- Candidate-specific failures carry record detail; they collapse
          -- exactly like a refused decision.
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end;

      readable_references := readable_references || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', record_id_value
        )
      );
    end loop;
  end loop;

  if group_count = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'readable', 'records', readable_references);
end
$_$;

COMMENT ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) IS 'Adapter-owned resolution of one uniqueness index conflict: duplicate record identities only, each behind the exact read decision, collapsing wholly to one generic refusal when any participant is unreadable.';

REVOKE ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) TO vortex_record_owner;
