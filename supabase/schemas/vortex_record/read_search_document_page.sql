create or replace function vortex_record.read_search_document_page(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_after_record_id uuid,
  p_required_tokens jsonb,
  p_limit integer
)
returns table (
  record_id uuid,
  source_record_version bigint,
  document_schema_version integer,
  entries jsonb,
  content_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or (context_value ->> 'applicationRootId') is null
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501', message = 'Search document scope is unavailable';
  end if;
  if p_record_type_id is null
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or p_after_record_id is null
    or pg_catalog.jsonb_typeof(p_required_tokens) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_required_tokens) > 2000
    or p_limit is null or p_limit not between 1 and 1000
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_required_tokens) as token(value)
      where pg_catalog.jsonb_typeof(token.value) <> 'string'
        or pg_catalog.length(token.value #>> '{}') > 2000
    ) then
    raise exception using errcode = '22023', message = 'Search document page selector is invalid';
  end if;

  return query
    select document.record_id, document.source_record_version,
      document.document_schema_version, document.entries, document.content_fingerprint
    from vortex_record.documents as document
    where document.organization_id = p_organization_id
      and (document.application_root_id = p_application_root_id
        or document.application_root_id is null)
      and document.record_type_id = p_record_type_id
      and not document.deleted
      and document.record_id > p_after_record_id
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(p_required_tokens) as required(token)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(document.entries) as indexed(value)
          where required.token = any (
            pg_catalog.regexp_split_to_array(pg_catalog.lower(indexed.value ->> 'text'),
              '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+')
          )
        )
      )
    order by document.record_id
    limit p_limit;
end
$function$;

alter function vortex_record.read_search_document_page(uuid,uuid,uuid,uuid,jsonb,integer) owner to vortex_owner;

revoke all on function vortex_record.read_search_document_page(uuid,uuid,uuid,uuid,jsonb,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.read_search_document_page(uuid,uuid,uuid,uuid,jsonb,integer)
  to vortex_request;

comment on function vortex_record.read_search_document_page(uuid,uuid,uuid,uuid,jsonb,integer) is
  'Returns one bounded keyset page of indexed documents for the validated human Application context; current Record reads still decide disclosure.';
