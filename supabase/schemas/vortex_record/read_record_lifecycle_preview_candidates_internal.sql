CREATE FUNCTION vortex_record.read_record_lifecycle_preview_candidates_internal(p_physical_table_token text, p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  result_value jsonb;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_limit is null
    or p_limit not between 1 and 500
    or ((p_after_created_at is null) <> (p_after_record_id is null))
    or (p_after_record_id is not null
      and p_after_record_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_organization_id <> vortex_context.organization_id()
    or p_application_root_id is distinct from vortex_context.application_root_id(false) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview candidates are unavailable';
  end if;

  execute pg_catalog.format(
    'with ranked as materialized (
       select stored.record_id,
              stored.concurrency_number,
              stored.created_at,
              stored.lifecycle_state,
              stored.deleted_at,
              pg_catalog.row_number() over (
                order by stored.created_at asc, stored.record_id asc
              )::bigint as record_position,
              pg_catalog.count(*) over ()::bigint as total_retained_count
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.storage_contract_id = $2
         and stored.application_root_id is not distinct from $3
         and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
     ), page as materialized (
       select ranked.*
       from ranked
       where $5::timestamptz is null
          or ranked.created_at > $5
          or (ranked.created_at = $5 and ranked.record_id > $6)
       order by ranked.created_at asc, ranked.record_id asc
       limit $4 + 1
     ), selected as materialized (
       select page.*
       from page
       order by page.created_at asc, page.record_id asc
       limit $4
     )
     select pg_catalog.jsonb_build_object(
       ''totalRetainedCount'', coalesce(
         (select ranked.total_retained_count from ranked limit 1), 0
       ),
       ''records'', coalesce((
         select pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''recordId'', selected.record_id,
             ''expectedRecordRevision'', selected.concurrency_number,
             ''createdAt'', pg_catalog.to_jsonb(selected.created_at),
             ''lifecycleState'', selected.lifecycle_state,
             ''deletedAt'', pg_catalog.to_jsonb(selected.deleted_at),
             ''recordPosition'', selected.record_position
           ) order by selected.created_at asc, selected.record_id asc
         )
         from selected
       ), ''[]''::jsonb),
       ''hasMore'', (select pg_catalog.count(*) > $4 from page)
     )',
    p_physical_table_token
  ) into strict result_value using
    p_organization_id, p_storage_contract_id, p_application_root_id,
    p_limit, p_after_created_at, p_after_record_id;

  return result_value;
end
$_$;

COMMENT ON FUNCTION vortex_record.read_record_lifecycle_preview_candidates_internal(p_physical_table_token text, p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) IS 'Private adapter-owned, forced-RLS lifecycle candidate page and global-position projection for Record owner.';

REVOKE ALL ON FUNCTION vortex_record.read_record_lifecycle_preview_candidates_internal(p_physical_table_token text, p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_record_lifecycle_preview_candidates_internal(p_physical_table_token text, p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) TO vortex_record_owner;
