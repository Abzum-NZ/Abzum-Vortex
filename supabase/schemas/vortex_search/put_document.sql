create or replace function vortex_search.put_document(
  p_organization_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_source_record_version bigint,
  p_deleted boolean,
  p_entries jsonb,
  p_content_fingerprint text
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored vortex_search.documents%rowtype;
  next_entries jsonb := case when p_deleted then '[]'::jsonb else p_entries end;
  next_fingerprint text := case when p_deleted then null else p_content_fingerprint end;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_record_type_id is null or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_record_id is null or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or (p_application_root_id is not null
      and not vortex_context.is_non_nil_uuid(p_application_root_id::text))
    or p_source_record_version is null
    or p_source_record_version not between 1 and 9007199254740991
    or p_deleted is null or p_entries is null then
    raise exception using errcode = '22023', message = 'Search document command is invalid';
  end if;

  -- The established request supplies the organisation; the caller only
  -- cross-checks it and cannot write into another organisation's index.
  if vortex_context.organization_id() is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Search document scope is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', 'search_document',
      p_organization_id::text, p_record_type_id::text, p_record_id::text), 643)
  );

  select existing.* into stored
  from vortex_search.documents as existing
  where existing.organization_id = p_organization_id
    and existing.record_type_id = p_record_type_id
    and existing.record_id = p_record_id;

  if found then
    if stored.source_record_version > p_source_record_version then
      return query select 'ignored_older'::text;
      return;
    end if;
    if stored.source_record_version = p_source_record_version then
      if stored.deleted then
        return query select
          case when p_deleted then 'replayed' else 'ignored_deleted' end::text;
        return;
      end if;
      if stored.deleted = p_deleted
        and stored.entries = next_entries
        and stored.content_fingerprint is not distinct from next_fingerprint
        and stored.application_root_id is not distinct from p_application_root_id then
        return query select 'replayed'::text;
        return;
      end if;
    end if;
    update vortex_search.documents as existing
    set application_root_id = p_application_root_id,
        source_record_version = p_source_record_version,
        deleted = p_deleted,
        entries = next_entries,
        content_fingerprint = next_fingerprint,
        updated_at = pg_catalog.statement_timestamp()
    where existing.organization_id = p_organization_id
      and existing.record_type_id = p_record_type_id
      and existing.record_id = p_record_id;
    return query select case
      when stored.source_record_version = p_source_record_version then 'rebuilt'
      else 'replaced'
    end::text;
    return;
  end if;

  insert into vortex_search.documents (
    organization_id, record_type_id, record_id, application_root_id,
    source_record_version, document_schema_version, deleted, entries,
    content_fingerprint
  ) values (
    p_organization_id, p_record_type_id, p_record_id, p_application_root_id,
    p_source_record_version, 1, p_deleted, next_entries, next_fingerprint
  );
  return query select 'stored'::text;
end
$function$;
revoke execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) to vortex_request;

comment on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one built search document or deletion marker for the request organisation; an older source version never overwrites a newer one, and a same-version rebuild replaces changed content.';

alter function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to vortex_search_owner;
