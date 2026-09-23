-- #643: Organisation-owned search documents.
--
-- One row holds the searchable text of one Record for the organisation that owns
-- it: source record identity and version, the weighted entries built by
-- runtime/search/src/document-store.ts, or a deletion marker. Sensitive,
-- unpermitted personal, non-searchable and recipient-copied shared-source values
-- never reach this table: the builder excludes them, and the key below has no
-- source-organisation column, so another organisation's content has nowhere to
-- be stored. Each entry keeps its field identity so serving can match only
-- fields the current person may read; results are rechecked against current
-- access at read time. Index serving and event-driven refresh are later Search
-- work.

begin;

create schema if not exists vortex_search authorization postgres;

revoke all on schema vortex_search from public, anon, authenticated, service_role;
grant usage on schema vortex_search to vortex_runtime, vortex_request;

-- Entries are a bounded array of objects holding exactly fieldId, priority,
-- weight and text, with distinct field identifiers and bounded non-empty text,
-- so no other value can ride along in a document.
create function vortex_search.document_entries_are_valid(p_entries jsonb)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_entries) <> 'array' then false
    else pg_catalog.jsonb_array_length(p_entries) <= 100
      and pg_catalog.pg_column_size(p_entries) <= 262144
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or not (entry.value ?& array['fieldId', 'priority', 'weight', 'text'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry.value)) <> 4
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') <> 'string'
          or (entry.value ->> 'fieldId') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or pg_catalog.jsonb_typeof(entry.value -> 'priority') <> 'string'
          or pg_catalog.jsonb_typeof(entry.value -> 'weight') <> 'number'
          or pg_catalog.jsonb_typeof(entry.value -> 'text') <> 'string'
          or pg_catalog.length(entry.value ->> 'text') not between 1 and 4000
          or (entry.value ->> 'priority', entry.value ->> 'weight')
            not in (('first', '3'), ('normal', '2'), ('last', '1'))
      )
      and (
        select pg_catalog.count(distinct entry.value ->> 'fieldId') = pg_catalog.count(*)
          and coalesce(pg_catalog.sum(pg_catalog.length(entry.value ->> 'text')), 0) <= 20000
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
      )
  end;
$function$;

create table vortex_search.documents (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id)
    constraint documents_organization_non_nil check (
      organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  record_type_id uuid not null
    constraint documents_record_type_non_nil check (
      record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  record_id uuid not null
    constraint documents_record_non_nil check (
      record_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  application_root_id uuid
    constraint documents_application_non_nil check (
      application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  source_record_version bigint not null
    constraint documents_source_version_range check (
      source_record_version between 1 and 9007199254740991
    ),
  document_schema_version integer not null
    constraint documents_schema_version_known check (document_schema_version = 1),
  deleted boolean not null,
  entries jsonb not null,
  content_fingerprint text,
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (organization_id, record_type_id, record_id),
  -- A deletion marker holds no content; a live document names its content hash.
  constraint documents_deletion_holds_no_content check (
    (deleted and entries = '[]'::jsonb and content_fingerprint is null)
    or (not deleted and content_fingerprint is not null
      and content_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  ),
  -- Entries are a bounded array of exactly the four builder-produced keys.
  constraint documents_entries_shape check (vortex_search.document_entries_are_valid(entries))
);

-- An Application scope must name an Application root of the same organisation.
create function vortex_search.enforce_document_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_root record;
begin
  if new.application_root_id is null then
    return new;
  end if;

  select root.organization_id, root.kind into application_root
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found or application_root.kind <> 'application'
    or application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Search document application does not belong to the organisation';
  end if;

  return new;
end
$function$;

create trigger documents_application_root_validation
  before insert or update on vortex_search.documents
  for each row execute function vortex_search.enforce_document_application_root();

alter table vortex_search.documents enable row level security;
alter table vortex_search.documents force row level security;

-- Reads stay inside the current request's organisation. Writes go only through
-- put_document below, so no role receives ungated INSERT, UPDATE or DELETE.
create policy documents_request_read on vortex_search.documents
  for select to vortex_request
  using (organization_id = vortex_context.organization_id());

revoke all on table vortex_search.documents
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant select on table vortex_search.documents to vortex_request;

alter default privileges for role postgres in schema vortex_search
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_search
  revoke all on sequences from public, anon, authenticated, service_role;

-- Application-scoped lookups within one organisation.
create index documents_application_idx
  on vortex_search.documents (organization_id, application_root_id, record_type_id)
  where application_root_id is not null;

-- Stores one built document or deletion marker for the request's own
-- organisation. A version older than the stored one is ignored. The same version
-- with the same content is a replay; with changed content (a rebuild after a
-- search configuration or privacy policy change) it replaces the row, so text
-- that may no longer be indexed does not remain searchable. A deletion marker is
-- final for its version. A newer version replaces the row, and a deletion
-- replaces content with a marker so a deleted record's text is not searchable.
create function vortex_search.put_document(
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

alter function vortex_search.document_entries_are_valid(jsonb) owner to postgres;
alter function vortex_search.enforce_document_application_root() owner to postgres;
alter function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to postgres;

revoke execute on function
  vortex_search.document_entries_are_valid(jsonb),
  vortex_search.enforce_document_application_root(),
  vortex_search.put_document(uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_search.put_document(uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text)
to vortex_request;

comment on table vortex_search.documents is
  'One organisation-owned search document or deletion marker per Record: source identity and version plus weighted entries built only from permitted searchable non-sensitive fields; never holds another organisation''s shared content.';
comment on function vortex_search.put_document(
  uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one built search document or deletion marker for the request organisation; an older source version never overwrites a newer one, and a same-version rebuild replaces changed content.';

commit;
