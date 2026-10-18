-- The Storage API uses its own connections. Session settings in the seed cannot
-- configure those connections; database defaults require privileges the local
-- operational postgres role deliberately does not have. Keep the destination
-- in protected platform data, provisioned by operations and the local seed.
set local role vortex_owner;

create table vortex_platform.storage_destination (
  singleton boolean primary key default true check (singleton),
  project_ref text not null check (project_ref ~ '^[a-z0-9][a-z0-9-]{0,119}$')
);
alter table vortex_platform.storage_destination enable row level security;
alter table vortex_platform.storage_destination force row level security;
revoke all on vortex_platform.storage_destination
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select, insert, update, delete on vortex_platform.storage_destination to postgres;
create policy storage_destination_operations on vortex_platform.storage_destination
  to postgres using (true) with check (true);
grant usage on schema vortex_platform to authenticated;

create or replace function vortex_platform.storage_destination_project()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  project text;
begin
  select destination.project_ref into project
  from vortex_platform.storage_destination as destination
  where destination.singleton;
  if project is null then
    raise exception using errcode = '55000',
      message = 'Storage destination has not been provisioned';
  end if;
  return project;
end
$function$;

alter function vortex_platform.storage_destination_project() owner to vortex_owner;
revoke all on function vortex_platform.storage_destination_project()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.storage_destination_project() to authenticated, postgres;
comment on function vortex_platform.storage_destination_project() is
  'Storage policy destination from operations-owned configuration, never caller-writable session settings.';

reset role;

-- Storage objects and their policies remain owned by the Storage integration.
DROP POLICY vortex_component_bundle_read ON storage.objects;
CREATE POLICY vortex_component_bundle_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = vortex_platform.storage_destination_project()) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
DROP POLICY vortex_component_bundle_upload ON storage.objects;
CREATE POLICY vortex_component_bundle_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = vortex_platform.storage_destination_project()) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
DROP POLICY vortex_private_file_delete ON storage.objects;
CREATE POLICY vortex_private_file_delete ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = vortex_platform.storage_destination_project()) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'delete'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
DROP POLICY vortex_private_file_read ON storage.objects;
CREATE POLICY vortex_private_file_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = vortex_platform.storage_destination_project()) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
DROP POLICY vortex_private_file_upload ON storage.objects;
CREATE POLICY vortex_private_file_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = vortex_platform.storage_destination_project()) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));

reset role;
