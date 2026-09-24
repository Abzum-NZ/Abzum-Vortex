-- #653: Authenticated private file downloads and previews.
--
-- Every download, range and preview request re-decides current authority and
-- then records one short-lived read grant. The File service's Storage credential
-- bridge claims that grant exactly once to mint one server-held read credential,
-- so a copied route, a replayed grant or a revoked viewer never reaches Storage.
--
-- The read decision adds no permission rules of its own. It composes the
-- existing protected single-record read, vortex_record.read_record, which owns
-- row access, attachment-field readability and the installed definition, and
-- additionally requires the record's attachment value to still name the file.
-- It therefore runs as the request role (security invoker): the File service
-- never widens what the viewer's own protected record read allows.

begin;

-- ----------------------------------------------------------------------------
-- One-time read grants
-- ----------------------------------------------------------------------------
create table vortex_file.download_grants (
  one_time_id uuid primary key
    constraint download_grants_one_time_id_non_nil check (
      one_time_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  file_id uuid not null
    references vortex_file.file_records (file_id),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  owner_record_type_id uuid not null,
  owner_record_id uuid not null,
  owner_field_id uuid not null,
  actor jsonb not null,
  purpose text not null,
  correlation_id uuid not null,
  expires_at timestamptz not null,
  credential_issued_at timestamptz,
  created_at timestamptz not null,
  constraint download_grants_ids_non_nil check (
    vortex_context.is_non_nil_uuid(owner_record_type_id::text)
    and vortex_context.is_non_nil_uuid(owner_record_id::text)
    and vortex_context.is_non_nil_uuid(owner_field_id::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint download_grants_purpose_valid check (purpose in ('download', 'preview')),
  -- A grant only bridges one request to its one credential of at most 60
  -- seconds, with a few seconds allowed for server clock skew.
  constraint download_grants_short_lived check (
    expires_at > created_at and expires_at <= created_at + interval '65 seconds'
  ),
  constraint download_grants_claimed_in_window check (
    credential_issued_at is null
    or (credential_issued_at >= created_at and credential_issued_at < expires_at)
  ),
  constraint download_grants_actor_object check (
    pg_catalog.jsonb_typeof(actor) = 'object'
  )
);

create index download_grants_org_expiry_idx
  on vortex_file.download_grants (organization_id, expires_at);

create index download_grants_file_idx
  on vortex_file.download_grants (file_id);

alter table vortex_file.download_grants enable row level security;
alter table vortex_file.download_grants force row level security;

revoke all on table vortex_file.download_grants
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- ----------------------------------------------------------------------------
-- Current read decision (request role)
-- ----------------------------------------------------------------------------

-- The application a file of the request organisation belongs to, so the caller
-- can open the application-scoped protected request that record reads need.
-- Row-level security on file_records confines this to the request organisation.
create function vortex_file.read_file_application(p_file_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  located_application_root_id uuid;
begin
  if p_file_id is null
    or p_file_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  select stored.application_root_id into located_application_root_id
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id
    and stored.lifecycle_state = 'active'
    and stored.owner_record_id is not null;
  if not found or located_application_root_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'located',
    'applicationRootId', located_application_root_id
  );
end
$function$;

-- The viewer's current authority to read one active, clean file: the owning
-- record must be readable through the protected record read, its attachment
-- field must be in the viewer's readable projection, and that field's current
-- value must still name this file. A missing file, a foreign one, an unreadable
-- record or field, and a detached file are one refusal.
create function vortex_file.decide_file_read(p_file_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  stored_organization_id uuid;
  stored_application_root_id uuid;
  stored_record_type_id uuid;
  stored_record_id uuid;
  stored_field_id uuid;
  stored_lifecycle_state text;
  stored_scanner_result text;
  projection jsonb;
  attached jsonb;
begin
  if p_file_id is null
    or p_file_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  select stored.organization_id, stored.application_root_id,
    stored.owner_record_type_id, stored.owner_record_id, stored.owner_field_id,
    stored.lifecycle_state, stored.scanner_result
  into stored_organization_id, stored_application_root_id,
    stored_record_type_id, stored_record_id, stored_field_id,
    stored_lifecycle_state, stored_scanner_result
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;
  if not found
    or stored_record_id is null
    or stored_lifecycle_state <> 'active'
    or stored_scanner_result <> 'clean' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  projection := vortex_record.read_record(stored_record_type_id, stored_record_id);
  if projection ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  attached := projection -> 'values' -> (stored_field_id::text);
  if pg_catalog.jsonb_typeof(attached) is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(attached) as member(value)
      where pg_catalog.jsonb_typeof(member.value) = 'string'
        and pg_catalog.lower(member.value #>> '{}') = p_file_id::text
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'organizationId', stored_organization_id,
    'applicationRootId', stored_application_root_id,
    'recordTypeId', stored_record_type_id,
    'recordId', stored_record_id,
    'fieldId', stored_field_id
  ));
end
$function$;

-- ----------------------------------------------------------------------------
-- File record and grant store (File service)
-- ----------------------------------------------------------------------------

-- The canonical FileRecord of one file of the request organisation.
create function vortex_file.read_file_for_download(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  stored vortex_file.file_records%rowtype;
begin
  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;
  return vortex_file.upload_file_record(stored);
end
$function$;

-- Records one unclaimed read grant for the request's own verified actor on an
-- active, clean file attached to the named record field, and purges a bounded
-- batch of this organisation's long-expired grants.
create function vortex_file.record_file_download_grant(
  p_one_time_id uuid,
  p_file_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_actor jsonb,
  p_purpose text,
  p_correlation_id uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.current_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  request_organization_id uuid := (established ->> 'organizationId')::uuid;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_actor is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File read scope is unavailable';
  end if;

  if p_one_time_id is null
    or p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_correlation_id is null
    or p_purpose is null or p_purpose not in ('download', 'preview')
    or p_expires_at is null
    or p_expires_at <= evaluated_at
    or p_expires_at > evaluated_at + interval '65 seconds' then
    raise exception using errcode = '22023', message = 'File read grant is invalid';
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = request_organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from p_owner_record_type_id
    or stored.owner_record_id is distinct from p_owner_record_id
    or stored.owner_field_id is distinct from p_owner_field_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  delete from vortex_file.download_grants as expired
  where expired.ctid in (
    select candidate.ctid
    from vortex_file.download_grants as candidate
    where candidate.organization_id = request_organization_id
      and candidate.expires_at < evaluated_at - interval '1 hour'
    order by candidate.expires_at
    limit 100
  );

  insert into vortex_file.download_grants (
    one_time_id, file_id, organization_id,
    owner_record_type_id, owner_record_id, owner_field_id,
    actor, purpose, correlation_id, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, request_organization_id,
    p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_purpose, p_correlation_id, p_expires_at, evaluated_at
  );

  return pg_catalog.jsonb_build_object('outcome', 'recorded');
end
$function$;

-- Claims an unexpired, unclaimed read grant of the request's own actor exactly
-- once and returns it with the current FileRecord, which must still be active,
-- clean and attached to the grant's record field.
create function vortex_file.claim_file_download_grant(p_one_time_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.current_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  claimed vortex_file.download_grants%rowtype;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null then
    return null;
  end if;

  select candidate.* into claimed
  from vortex_file.download_grants as candidate
  where candidate.one_time_id = p_one_time_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found
    or claimed.credential_issued_at is not null
    or claimed.expires_at <= evaluated_at
    or claimed.actor is distinct from request_actor then
    return null;
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = claimed.file_id
    and candidate.organization_id = claimed.organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from claimed.owner_record_type_id
    or stored.owner_record_id is distinct from claimed.owner_record_id
    or stored.owner_field_id is distinct from claimed.owner_field_id then
    return null;
  end if;

  update vortex_file.download_grants
  set credential_issued_at = evaluated_at
  where one_time_id = claimed.one_time_id;

  return pg_catalog.jsonb_build_object(
    'grant', pg_catalog.jsonb_build_object(
      'kind', 'download',
      'organizationId', claimed.organization_id,
      'actor', claimed.actor,
      'recordTypeId', claimed.owner_record_type_id,
      'recordId', claimed.owner_record_id,
      'fieldId', claimed.owner_field_id,
      'fileId', claimed.file_id,
      'oneTimeId', claimed.one_time_id,
      'expiresAt', vortex_file.upload_timestamp(claimed.expires_at)
    ),
    'fileRecord', vortex_file.upload_file_record(stored),
    'correlationId', claimed.correlation_id
  );
end
$function$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
revoke execute on function
  vortex_file.read_file_application(uuid),
  vortex_file.decide_file_read(uuid),
  vortex_file.read_file_for_download(uuid),
  vortex_file.record_file_download_grant(
    uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
  ),
  vortex_file.claim_file_download_grant(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_file.read_file_application(uuid),
  vortex_file.decide_file_read(uuid),
  vortex_file.read_file_for_download(uuid),
  vortex_file.record_file_download_grant(
    uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
  ),
  vortex_file.claim_file_download_grant(uuid)
to vortex_request;

comment on table vortex_file.download_grants is
  'One-request read grants; each issues exactly one short-lived server-held Storage read credential.';
comment on function vortex_file.read_file_application(uuid) is
  'Locates the application of an active attached file of the request organisation.';
comment on function vortex_file.decide_file_read(uuid) is
  'Decides current read authority for a file through the protected record read and the attachment value that names it.';
comment on function vortex_file.read_file_for_download(uuid) is
  'Reads the canonical FileRecord of one file of the request organisation.';
comment on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) is
  'Records one unclaimed short-lived read grant for the request actor on an active clean attached file.';
comment on function vortex_file.claim_file_download_grant(uuid) is
  'Claims an unexpired read grant of the request actor exactly once with its current FileRecord.';

commit;
