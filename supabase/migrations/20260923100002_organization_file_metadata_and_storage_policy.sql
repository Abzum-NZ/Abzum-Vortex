-- #647: Private organisation-owned file metadata and private Storage policy.
--
-- One row holds one private file's owning organisation, application, record type,
-- record and attachment field, its safe display name, verified media type,
-- extension, size and checksum, its verified human-or-system uploader, and its
-- private bucket and organisation-scoped unguessable object path.
--
-- The Storage policies below are the object/operation half of the credential
-- bridge: they inspect the signed File operation claims and admit exactly one
-- bucket, object and operation inside the 60-second boundary. Minting the
-- credential, downloading and previewing bytes remain out of this slice, so this
-- migration adds no signing key, no service credential and no broad grant.

begin;

create schema if not exists vortex_file authorization postgres;

revoke all on schema vortex_file from public, anon, authenticated, service_role;
grant usage on schema vortex_file to vortex_runtime, vortex_request;

-- ----------------------------------------------------------------------------
-- Private file metadata
-- ----------------------------------------------------------------------------
create table vortex_file.file_records (
  file_id uuid primary key
    constraint file_records_file_id_non_nil check (
      file_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id)
    constraint file_records_organization_non_nil check (
      organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  application_root_id uuid
    references vortex_definition.roots (root_id)
    constraint file_records_application_non_nil check (
      application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  owner_record_type_id uuid,
  owner_record_id uuid,
  owner_field_id uuid,
  owning_attachment_references uuid[] not null default '{}',
  lifecycle_state text not null,
  original_safe_display_name text not null,
  detected_media_type text not null,
  extension text not null,
  size_bytes bigint not null,
  checksum text not null,
  storage_key text not null,
  bucket_id text not null default 'private_files',
  scanner_name text not null,
  scanner_version text not null,
  scanner_result text not null,
  preview_references jsonb not null default '[]'::jsonb,
  uploaded_by jsonb not null,
  legal_hold boolean not null default false,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  activated_at timestamptz,
  deleted_at timestamptz,
  removal_due_at timestamptz,
  constraint file_records_lifecycle_state_valid check (
    lifecycle_state in (
      'pending',
      'uploaded',
      'scanning',
      'active',
      'quarantined',
      'abandoned',
      'soft_deleted',
      'removed'
    )
  ),
  constraint file_records_display_name_valid check (
    pg_catalog.char_length(original_safe_display_name) between 1 and 255
    and original_safe_display_name !~ '[\r\n\t]'
  ),
  constraint file_records_media_type_valid check (
    pg_catalog.char_length(detected_media_type) between 1 and 200
  ),
  constraint file_records_extension_valid check (
    extension ~ '^\.[a-z0-9]+$'
  ),
  constraint file_records_size_bytes_non_negative check (
    size_bytes >= 0
  ),
  constraint file_records_checksum_valid check (
    checksum ~ '^sha256:[a-f0-9]{64}$'
  ),
  -- Business files live only in the private bucket; published public assets are a
  -- separate variant and never share this store.
  constraint file_records_bucket_private check (
    bucket_id = 'private_files'
  ),
  -- The object path is organisation-scoped, carries this file's identifier and 128
  -- bits of entropy, and never carries the original file name.
  constraint file_records_storage_key_valid check (
    storage_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{32}$'
    and pg_catalog.starts_with(
      storage_key, organization_id::text || '/' || file_id::text || '/'
    )
  ),
  constraint file_records_scanner_result_valid check (
    scanner_result in ('pending', 'clean', 'quarantined', 'refused')
  ),
  -- Owner record type, record and attachment field travel together or not at all.
  constraint file_records_owner_complete check (
    pg_catalog.num_nonnulls(owner_record_type_id, owner_record_id, owner_field_id) in (0, 3)
  ),
  -- A file becomes active only after its safety check passes, and an active file
  -- records its activation and carries no deletion time.
  constraint file_records_active_shape check (
    lifecycle_state <> 'active'
    or (scanner_result = 'clean' and activated_at is not null and deleted_at is null)
  ),
  constraint file_records_quarantined_shape check (
    lifecycle_state <> 'quarantined'
    or scanner_result in ('quarantined', 'refused')
  ),
  constraint file_records_soft_deleted_shape check (
    lifecycle_state <> 'soft_deleted' or deleted_at is not null
  ),
  constraint file_records_deleted_after_creation check (
    deleted_at is null or deleted_at >= created_at
  ),
  -- Attribution names a verified human organisation account with its global
  -- identity, or a registered system actor. A system upload never carries a
  -- fabricated organisation account.
  constraint file_records_uploaded_by_actor check (
    pg_catalog.jsonb_typeof(uploaded_by) = 'object'
    and (
      (
        uploaded_by ->> 'kind' = 'human'
        and uploaded_by ?& array['kind', 'organizationAccountId', 'identityId']
        and not uploaded_by ? 'systemActorId'
        and vortex_context.is_non_nil_uuid(uploaded_by ->> 'organizationAccountId')
        and vortex_context.is_non_nil_uuid(uploaded_by ->> 'identityId')
      )
      or (
        uploaded_by ->> 'kind' = 'system'
        and uploaded_by ?& array['kind', 'systemActorId']
        and not uploaded_by ?| array['organizationAccountId', 'identityId']
        and vortex_context.is_non_nil_uuid(uploaded_by ->> 'systemActorId')
      )
    )
  )
);

-- An Application scope must name an Application root of the same organisation.
create function vortex_file.enforce_file_application_root()
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

  if not found then
    raise exception using errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;

  if application_root.kind <> 'application' then
    raise exception using errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Referenced application root organization does not match file organization';
  end if;

  return new;
end
$function$;

create trigger file_records_application_root_validation
  before insert or update on vortex_file.file_records
  for each row execute function vortex_file.enforce_file_application_root();

-- Forced row-level security keeps every read and write inside the current
-- request's organisation, so file metadata can never cross an organisation
-- boundary even when a caller names another organisation's file identifier.
alter table vortex_file.file_records enable row level security;
alter table vortex_file.file_records force row level security;

create policy file_records_request_read on vortex_file.file_records
  for select to vortex_request
  using (organization_id = vortex_context.organization_id());

-- This slice installs the store and its isolation only. File metadata is written
-- by the protected File-service operations that admit an upload and activate it in
-- a record save, so no role receives ungated INSERT or UPDATE here.
revoke all on table vortex_file.file_records
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant select on table vortex_file.file_records to vortex_request;

alter default privileges for role postgres in schema vortex_file
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_file
  revoke all on sequences from public, anon, authenticated, service_role;

-- Two files never share one stored object.
create unique index idx_file_records_storage_key
  on vortex_file.file_records (storage_key);

create index idx_file_records_org_owner
  on vortex_file.file_records (organization_id, owner_record_id, owner_field_id)
  where owner_record_id is not null;

create index idx_file_records_org_lifecycle
  on vortex_file.file_records (organization_id, lifecycle_state);

-- ----------------------------------------------------------------------------
-- Private bucket and exact Storage operation policies
-- ----------------------------------------------------------------------------

-- Supabase owns storage.buckets and storage.objects. This migration only makes
-- sure the business bucket exists and is private, and installs Vortex's policies
-- on it; it defines no Storage table and adds no Storage service credential.
insert into storage.buckets (id, name, public)
values ('private_files', 'private_files', false)
on conflict (id) do update set public = false;

-- The Storage service already enables row level security on its own table, and
-- only its owner may run the ALTER, so enable it only when it is somehow off.
do $enable_rls$
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'storage.objects'::regclass) then
    alter table storage.objects enable row level security;
  end if;
end
$enable_rls$;

drop policy if exists "vortex_private_file_upload" on storage.objects;
drop policy if exists "vortex_private_file_read" on storage.objects;
drop policy if exists "vortex_private_file_delete" on storage.objects;

-- The three policies below read the caller's own signed claims through auth.jwt()
-- and share one shape, so each admits exactly one operation on exactly one object:
--
--   * the private business bucket, never a public asset bucket;
--   * a File-specific token kind, so an ordinary Auth token authorises nothing;
--   * the destination project this database is bound to, so a token minted for
--     another project is refused. That binding is environment configuration:
--       alter database <database> set vortex.destination_project = '<project ref>';
--     While it is unset every policy below denies, which is the intended
--     fail-closed behaviour for an environment that has not been bound yet;
--   * the exact object path, inside that organisation's own path prefix;
--   * the single named operation; and
--   * the 60-second boundary, checking issuance as well as expiry so a
--     long-lived or future-dated credential cannot be presented.
--
-- Vortex adds no schema, table or function access for `authenticated` to make
-- this work: the predicates use only the caller's own token and built-ins. These
-- policies are object and operation isolation only; the File service still owns
-- the live record, field and grant decision on every request.

-- INSERT only, at the exact admitted pending object. There is deliberately no
-- UPDATE policy, so an upload credential cannot overwrite or upsert an object: a
-- replacement upload uses a new pending object and an authorised record save.
create policy "vortex_private_file_upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'private_files'
  and auth.jwt() ->> 'tokenKind' = 'vortex_file_storage_operation'
  and auth.jwt() ->> 'role' = 'authenticated'
  and auth.jwt() ->> 'destinationProject'
    = nullif(current_setting('vortex.destination_project', true), '')
  and auth.jwt() ->> 'bucketId' = bucket_id
  and auth.jwt() ->> 'objectPath' = name
  and name like (auth.jwt() ->> 'organizationId') || '/%'
  and (auth.jwt() ->> 'organizationId') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and auth.jwt() ->> 'operation' = 'upload'
  and (auth.jwt() ->> 'iat') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp')::bigint > (auth.jwt() ->> 'iat')::bigint
  and (auth.jwt() ->> 'exp')::bigint - (auth.jwt() ->> 'iat')::bigint <= 60
  and (auth.jwt() ->> 'iat')::bigint
    <= floor(date_part('epoch', clock_timestamp()))::bigint + 5
  and (auth.jwt() ->> 'exp')::bigint
    >= floor(date_part('epoch', clock_timestamp()))::bigint
);

-- SELECT is pinned to the single named object, so the same privilege cannot be
-- used to list or enumerate an organisation's file store.
create policy "vortex_private_file_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'private_files'
  and auth.jwt() ->> 'tokenKind' = 'vortex_file_storage_operation'
  and auth.jwt() ->> 'role' = 'authenticated'
  and auth.jwt() ->> 'destinationProject'
    = nullif(current_setting('vortex.destination_project', true), '')
  and auth.jwt() ->> 'bucketId' = bucket_id
  and auth.jwt() ->> 'objectPath' = name
  and name like (auth.jwt() ->> 'organizationId') || '/%'
  and (auth.jwt() ->> 'organizationId') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and auth.jwt() ->> 'operation' = 'read'
  and (auth.jwt() ->> 'iat') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp')::bigint > (auth.jwt() ->> 'iat')::bigint
  and (auth.jwt() ->> 'exp')::bigint - (auth.jwt() ->> 'iat')::bigint <= 60
  and (auth.jwt() ->> 'iat')::bigint
    <= floor(date_part('epoch', clock_timestamp()))::bigint + 5
  and (auth.jwt() ->> 'exp')::bigint
    >= floor(date_part('epoch', clock_timestamp()))::bigint
);

create policy "vortex_private_file_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'private_files'
  and auth.jwt() ->> 'tokenKind' = 'vortex_file_storage_operation'
  and auth.jwt() ->> 'role' = 'authenticated'
  and auth.jwt() ->> 'destinationProject'
    = nullif(current_setting('vortex.destination_project', true), '')
  and auth.jwt() ->> 'bucketId' = bucket_id
  and auth.jwt() ->> 'objectPath' = name
  and name like (auth.jwt() ->> 'organizationId') || '/%'
  and (auth.jwt() ->> 'organizationId') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and auth.jwt() ->> 'operation' = 'delete'
  and (auth.jwt() ->> 'iat') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp') ~ '^[0-9]{1,18}$'
  and (auth.jwt() ->> 'exp')::bigint > (auth.jwt() ->> 'iat')::bigint
  and (auth.jwt() ->> 'exp')::bigint - (auth.jwt() ->> 'iat')::bigint <= 60
  and (auth.jwt() ->> 'iat')::bigint
    <= floor(date_part('epoch', clock_timestamp()))::bigint + 5
  and (auth.jwt() ->> 'exp')::bigint
    >= floor(date_part('epoch', clock_timestamp()))::bigint
);

revoke all on function vortex_file.enforce_file_application_root()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on schema vortex_file is
  'Private file metadata store and the private Storage policies enforcing organisation ownership and exact signed operation scope.';
comment on table vortex_file.file_records is
  'One private organisation-owned file: owning application, record type, record and attachment field, safe display name, verified media type, size and checksum, verified human-or-system uploader, private bucket and organisation-scoped unguessable object path.';
comment on function vortex_file.enforce_file_application_root() is
  'Keeps a file''s Application scope inside its own organisation and on a root of kind application.';

commit;
