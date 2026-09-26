-- #1144: Immutable, content-addressed storage for custom component bundles.
--
-- A custom component bundle is a set of files the App Designer and the
-- installation prepare step publish. Each bundle has one entry file whose
-- SHA-384 digest is recorded in its component release for Subresource Integrity
-- (application packages appendix, "Custom components"). Publication uploads the
-- entry file and its assets under that digest and refuses a bundle whose bytes
-- do not match the recorded digest.
--
-- This migration owns storage only. It creates one private bucket and the two
-- Storage object policies that admit exactly one publication upload or one
-- serving read of one content address inside the 60-second boundary. There is
-- deliberately no public or authenticated policy: the bucket is never
-- public-writable, and a bundle is read only through the serving route, which
-- mints the exact read credential for the one requested address.
--
-- Object layout inside the bucket (no organisation, record or person identifier
-- appears anywhere in a path):
--
--   manifests/<96 lowercase hex>.json   the bundle manifest: entry file,
--                                       recorded digest and every file digest
--   bundles/<96 lowercase hex>/<path>   one bundle file beneath its entry digest
--
-- The content address (<96 hex>) is the SHA-384 digest of the bundle's entry
-- file. The manifest records every file's own SHA-384 so the serving route can
-- verify each served byte.

begin;

-- Supabase owns storage.buckets and storage.objects. This migration only makes
-- sure the component bundle bucket exists and is private, and installs Vortex's
-- policies on it; it defines no Storage table and adds no Storage credential.
insert into storage.buckets (id, name, public)
values ('component_bundles', 'component_bundles', false)
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

drop policy if exists "vortex_component_bundle_upload" on storage.objects;
drop policy if exists "vortex_component_bundle_read" on storage.objects;

-- The two policies below read the caller's own signed claims through auth.jwt()
-- and share one shape, so each admits exactly one operation on exactly one
-- content address:
--
--   * the private component bundle bucket, never a public or business bucket;
--   * a Component-bundle-specific token kind, so an ordinary Auth token or a
--     private business file token authorises nothing;
--   * the destination project this database is bound to, so a token minted for
--     another project is refused. That binding is environment configuration:
--       alter database <database> set vortex.destination_project = '<project ref>';
--     While it is unset every policy below denies, which is the intended
--     fail-closed behaviour for an environment that has not been bound yet;
--   * the exact object path, which is the content address (or a file beneath
--     it) and never an organisation, record or person identifier;
--   * the single named operation; and
--   * the 60-second boundary, checking issuance as well as expiry so a
--     long-lived or future-dated credential cannot be presented.
--
-- Vortex adds no schema, table or function access for `authenticated` to make
-- this work: the predicates use only the caller's own token and built-ins. There
-- is deliberately no UPDATE or DELETE policy, so a published object can never be
-- overwritten or removed: a changed bundle is a new content address.

-- INSERT only, at the exact content address. A publication credential can add
-- one object under the bundle it just verified and nothing else.
create policy "vortex_component_bundle_upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'component_bundles'
  and auth.jwt() ->> 'tokenKind' = 'vortex_component_bundle_operation'
  and auth.jwt() ->> 'role' = 'authenticated'
  and auth.jwt() ->> 'destinationProject'
    = nullif(current_setting('vortex.destination_project', true), '')
  and auth.jwt() ->> 'bucketId' = bucket_id
  and auth.jwt() ->> 'objectPath' = name
  and name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'
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
-- used to list or enumerate the bundle store.
create policy "vortex_component_bundle_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'component_bundles'
  and auth.jwt() ->> 'tokenKind' = 'vortex_component_bundle_operation'
  and auth.jwt() ->> 'role' = 'authenticated'
  and auth.jwt() ->> 'destinationProject'
    = nullif(current_setting('vortex.destination_project', true), '')
  and auth.jwt() ->> 'bucketId' = bucket_id
  and auth.jwt() ->> 'objectPath' = name
  and name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'
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

commit;
