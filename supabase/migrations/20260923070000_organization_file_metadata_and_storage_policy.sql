-- Issue #647: Implement organization-owned file metadata and private storage policy.
-- Stores owner record/field, safe name, detected type, size, checksum, uploader actor union,
-- and lifecycle state under organization-scoped unguessable object paths.
-- Implements private bucket policies on storage.objects using exact signed operation claims.

create schema if not exists vortex_file authorization postgres;

revoke all on schema vortex_file from public, anon, authenticated, service_role;
revoke all on schema vortex_file from vortex_runtime, vortex_request;
grant usage on schema vortex_file to vortex_runtime, vortex_request;

create table if not exists vortex_file.file_records (
  file_id uuid primary key,
  organization_id uuid not null,
  application_root_id uuid,
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
  created_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  deleted_at timestamptz,
  removal_due_at timestamptz,
  constraint file_records_file_id_non_nil check (
    file_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint file_records_organization_id_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
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
    and original_safe_display_name !~ '[\r\n\t\0]'
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
  constraint file_records_storage_key_valid check (
    storage_key like organization_id::text || '/%'
    and pg_catalog.char_length(storage_key) between 1 and 1000
    and storage_key !~ '(\.\.|\\)'
  ),
  constraint file_records_scanner_result_valid check (
    scanner_result in ('pending', 'clean', 'quarantined', 'refused')
  ),
  constraint file_records_uploaded_by_actor check (
    uploaded_by ? 'kind'
    and (
      (uploaded_by ->> 'kind' = 'human' and uploaded_by ? 'organizationAccountId')
      or
      (uploaded_by ->> 'kind' = 'system' and uploaded_by ? 'systemActorId')
    )
  )
);

revoke all on table vortex_file.file_records from public, anon, authenticated, service_role;
grant select, insert, update on table vortex_file.file_records to vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_file
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_file
  revoke all on sequences from public, anon, authenticated, service_role;

create index if not exists idx_file_records_org_file
  on vortex_file.file_records (organization_id, file_id);

create index if not exists idx_file_records_org_storage_key
  on vortex_file.file_records (organization_id, storage_key);

create index if not exists idx_file_records_org_owner
  on vortex_file.file_records (organization_id, owner_record_id, owner_field_id)
  where owner_record_id is not null;

create index if not exists idx_file_records_org_lifecycle
  on vortex_file.file_records (organization_id, lifecycle_state);

-- Supabase Storage Private Bucket and Row Policies
create schema if not exists storage authorization postgres;

create table if not exists storage.buckets (
  id text not null primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid not null default gen_random_uuid() primary key,
  bucket_id text,
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text
);

insert into storage.buckets (id, name, public)
values ('private_files', 'private_files', false)
on conflict (id) do nothing;

create or replace function vortex_file.current_operation_claims()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  claims jsonb;
begin
  if pg_catalog.to_regprocedure('auth.jwt()') is not null then
    execute 'select auth.jwt()' into claims;
    if claims is not null then
      return claims;
    end if;
  end if;

  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    return claims;
  exception when others then
    return null;
  end;
end
$function$;

revoke all on function vortex_file.current_operation_claims()
  from public, anon, service_role;
grant execute on function vortex_file.current_operation_claims()
  to authenticated, vortex_runtime, vortex_request;

alter table storage.objects enable row level security;

drop policy if exists "vortex_private_file_upload" on storage.objects;
drop policy if exists "vortex_private_file_read" on storage.objects;
drop policy if exists "vortex_private_file_delete" on storage.objects;

-- Exact Storage operation policies inspecting signed claims:
-- Denies missing/malformed scope, ordinary Auth tokens, wrong operations, and cross-organization access.
create policy "vortex_private_file_upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'private_files'
  and bucket_id = (vortex_file.current_operation_claims() ->> 'bucketId')
  and name = (vortex_file.current_operation_claims() ->> 'objectPath')
  and name like (vortex_file.current_operation_claims() ->> 'organizationId') || '/%'
  and (vortex_file.current_operation_claims() ->> 'tokenKind') = 'vortex_file_storage_operation'
  and (vortex_file.current_operation_claims() ->> 'operation') = 'upload'
  and (vortex_file.current_operation_claims() ->> 'exp')::bigint >= extract(epoch from clock_timestamp())
);

create policy "vortex_private_file_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'private_files'
  and bucket_id = (vortex_file.current_operation_claims() ->> 'bucketId')
  and name = (vortex_file.current_operation_claims() ->> 'objectPath')
  and name like (vortex_file.current_operation_claims() ->> 'organizationId') || '/%'
  and (vortex_file.current_operation_claims() ->> 'tokenKind') = 'vortex_file_storage_operation'
  and (vortex_file.current_operation_claims() ->> 'operation') = 'read'
  and (vortex_file.current_operation_claims() ->> 'exp')::bigint >= extract(epoch from clock_timestamp())
);

create policy "vortex_private_file_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'private_files'
  and bucket_id = (vortex_file.current_operation_claims() ->> 'bucketId')
  and name = (vortex_file.current_operation_claims() ->> 'objectPath')
  and name like (vortex_file.current_operation_claims() ->> 'organizationId') || '/%'
  and (vortex_file.current_operation_claims() ->> 'tokenKind') = 'vortex_file_storage_operation'
  and (vortex_file.current_operation_claims() ->> 'operation') = 'delete'
  and (vortex_file.current_operation_claims() ->> 'exp')::bigint >= extract(epoch from clock_timestamp())
);

comment on schema vortex_file is
  'Private file metadata store and storage policies enforcing organization ownership and exact signed operation claims.';
comment on table vortex_file.file_records is
  'Stores private organization-owned file metadata, lifecycle states, owner record/field links, and verified human-or-system uploader attribution.';
comment on function vortex_file.current_operation_claims() is
  'Extracts signed storage operation claims from auth.jwt() or request context.';
