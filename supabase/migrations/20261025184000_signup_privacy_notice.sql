set role vortex_owner;

create table if not exists vortex_identity.privacy_notice_versions (
  id uuid primary key,
  publication_order bigint generated always as identity unique,
  version_label text not null unique check (length(version_label) between 1 and 100),
  locator text not null unique,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_at timestamptz not null,
  published_at timestamptz not null,
  published_by uuid not null references vortex_identity.identity_projections(identity_id),
  correlation_id uuid not null unique,
  check (isfinite(effective_at) and effective_at <= published_at)
);
-- Current is exactly the latest publication: no mutable current flag or overlapping windows.
-- No tenant exists at signup. Evidence is identity-scoped and survives projection/account removal.
create table if not exists vortex_identity.privacy_notice_acknowledgments (
  identity_id uuid not null,
  notice_version_id uuid not null references vortex_identity.privacy_notice_versions(id),
  acknowledged_at timestamptz not null,
  channel text not null check (channel in ('email_registration', 'identity_registration')),
  correlation_id uuid not null unique,
  primary key (identity_id, notice_version_id)
);
alter table vortex_identity.privacy_notice_versions enable row level security;
alter table vortex_identity.privacy_notice_versions force row level security;
alter table vortex_identity.privacy_notice_acknowledgments enable row level security;
alter table vortex_identity.privacy_notice_acknowledgments force row level security;
revoke all on table vortex_identity.privacy_notice_versions, vortex_identity.privacy_notice_acknowledgments
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant select on table vortex_identity.privacy_notice_versions, vortex_identity.privacy_notice_acknowledgments to postgres;
create or replace function vortex_identity.read_current_privacy_notice(p_version_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  notice vortex_identity.privacy_notice_versions;
begin
  select v.* into notice
  from vortex_identity.privacy_notice_versions v
  where (p_version_id is null or v.id = p_version_id)
    and v.effective_at <= pg_catalog.statement_timestamp()
  order by v.publication_order desc limit 1;
  if not found then
    raise exception using errcode = '55000', message = 'privacy_notice_unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', notice.id, 'versionLabel', notice.version_label,
    'locator', notice.locator, 'contentSha256', notice.content_sha256,
    'effectiveAt', pg_catalog.to_char(notice.effective_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', notice.content
  );
end
$function$;
revoke all on function vortex_identity.read_current_privacy_notice(uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.read_current_privacy_notice(uuid) to vortex_runtime, postgres;
alter function vortex_identity.read_current_privacy_notice(uuid) owner to vortex_owner;

create or replace function vortex_identity.publish_privacy_notice_version(
  p_publisher_identity_id uuid,
  p_version_label text,
  p_effective_at timestamptz,
  p_content jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  version_id uuid := pg_catalog.gen_random_uuid();
  published_at timestamptz;
begin
  -- Shares the publication lock with signup validation, so a version cannot change mid-insert.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vortex.privacy.notice', 0));
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id = p_publisher_identity_id and p.state = 'active' for share;
  published_at := pg_catalog.clock_timestamp();
  if not found or vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    p_publisher_identity_id, published_at
  ) is null then
    raise exception using errcode = '42501', message = 'Privacy notice publication is unavailable';
  end if;
  if p_version_label is null or pg_catalog.length(p_version_label) not between 1 and 100
    or p_effective_at is null or not pg_catalog.isfinite(p_effective_at)
    or p_effective_at > published_at
    or p_content is null or pg_catalog.jsonb_typeof(p_content) <> 'object'
    or pg_catalog.jsonb_typeof(p_content -> 'title') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_content -> 'collectionNotice') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_content -> 'paragraphs') is distinct from 'array'
    then
    raise exception using errcode = '22023', message = 'Privacy notice publication input is invalid';
  end if;
  insert into vortex_identity.privacy_notice_versions (
    id, version_label, locator, content, content_sha256, effective_at, published_at,
    published_by, correlation_id
  ) values (
    version_id, p_version_label, '/auth/privacy?version=' || version_id::text,
    p_content, pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_content::text, 'UTF8'), 'sha256'), 'hex'), p_effective_at, published_at,
    p_publisher_identity_id, pg_catalog.gen_random_uuid()
  );
  return version_id;
end
$function$;
revoke all on function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
-- The operational command is server-only; no browser role can name a publisher or publish content.
grant execute on function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb) to postgres;
alter function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb) owner to vortex_owner;

create or replace function vortex_identity.validate_privacy_notice_internal(p_metadata jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_version uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vortex.privacy.notice', 0));
  select v.id into current_version
    from vortex_identity.privacy_notice_versions v
    where v.effective_at <= pg_catalog.clock_timestamp()
    order by v.publication_order desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'privacy_notice_unavailable';
  end if;
  if (p_metadata -> 'privacy_notice_acknowledged') is distinct from 'true'::jsonb then
    raise exception using errcode = 'P0001', message = 'privacy_notice_required';
  end if;
  if (p_metadata ->> 'privacy_notice_version_id') is distinct from current_version::text then
    raise exception using errcode = 'P0001', message = 'privacy_notice_changed';
  end if;
  return current_version;
end
$function$;
revoke all on function vortex_identity.validate_privacy_notice_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.validate_privacy_notice_internal(jsonb) owner to vortex_owner;

create or replace function vortex_identity.before_user_created(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_identity.validate_privacy_notice_internal(event #> '{user,user_metadata}');
  return '{}'::jsonb;
exception when sqlstate 'P0001' then
  if sqlerrm not in ('privacy_notice_required', 'privacy_notice_changed', 'privacy_notice_unavailable') then
    raise;
  end if;
  return pg_catalog.jsonb_build_object('error', pg_catalog.jsonb_build_object(
    'http_code', 400, 'message', sqlerrm
  ));
end
$function$;
revoke all on function vortex_identity.before_user_created(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.before_user_created(jsonb) to supabase_auth_admin;
alter function vortex_identity.before_user_created(jsonb) owner to vortex_owner;
-- Schema ownership remains with postgres; vortex_owner cannot grant schema USAGE onward.
reset role;
grant usage on schema vortex_identity to supabase_auth_admin;
set role vortex_owner;

create or replace function vortex_identity.append_signup_privacy_acknowledgment()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  notice_version uuid;
begin
  -- GoTrue v2.196.0 requires before_user_created outside its insert transaction. Evidence belongs here.
  notice_version := vortex_identity.validate_privacy_notice_internal(new.raw_user_meta_data);
  insert into vortex_identity.privacy_notice_acknowledgments (
    identity_id, notice_version_id, acknowledged_at, channel, correlation_id
  ) values (
    new.id, notice_version, pg_catalog.clock_timestamp(),
    case when new.raw_app_meta_data ->> 'provider' = 'email'
      then 'email_registration' else 'identity_registration' end,
    pg_catalog.gen_random_uuid()
  );
  return new;
end
$function$;
revoke all on function vortex_identity.append_signup_privacy_acknowledgment()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.append_signup_privacy_acknowledgment() owner to vortex_owner;
-- The operational migration role needs EXECUTE to attach the trigger to GoTrue's table.
grant execute on function vortex_identity.append_signup_privacy_acknowledgment() to postgres;

create or replace function vortex_identity.refuse_privacy_notice_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception using errcode = '42501', message = 'Privacy notice evidence is immutable';
end
$function$;
revoke all on function vortex_identity.refuse_privacy_notice_mutation()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.refuse_privacy_notice_mutation() owner to vortex_owner;

drop trigger if exists privacy_notice_versions_immutable on vortex_identity.privacy_notice_versions;
create trigger privacy_notice_versions_immutable
before update or delete on vortex_identity.privacy_notice_versions
for each row execute function vortex_identity.refuse_privacy_notice_mutation();
drop trigger if exists privacy_notice_acknowledgments_immutable on vortex_identity.privacy_notice_acknowledgments;
create trigger privacy_notice_acknowledgments_immutable
before update or delete on vortex_identity.privacy_notice_acknowledgments
for each row execute function vortex_identity.refuse_privacy_notice_mutation();
reset role;
-- GoTrue v2.196.0 requires before_user_created to run outside its user-insert transaction.
-- Evidence must be appended by this trigger to commit or roll back with the account.
-- guard-allow: migration-owner-role The GoTrue-owned auth table requires postgres to attach this approved integration trigger.
drop trigger if exists vortex_signup_privacy_acknowledgment on auth.users;
-- guard-allow: migration-owner-role The GoTrue-owned auth table requires postgres for the approved integration trigger.
create trigger vortex_signup_privacy_acknowledgment
  after insert on auth.users
  for each row execute function vortex_identity.append_signup_privacy_acknowledgment();
reset role;