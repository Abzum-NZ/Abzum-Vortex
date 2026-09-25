-- #614: Private content-free invalidation channels.
--
-- Live updates let an open page learn that relevant data may have changed
-- without ever carrying a business value. This migration installs the database
-- half of that contract; its runtime half is
-- `runtime/event/src/invalidation-channel.ts`, which formats the identical
-- topic string and validates the identical envelope.
--
--   * one deterministic, organisation- and application-scoped private Broadcast
--     topic per install;
--   * row rules on `realtime.messages` that admit an authenticated person only
--     to the topics of an organisation and application they may currently open,
--     where the organisation is derived from the verified identity and never
--     from the topic string alone; and
--   * one protected post-commit publish helper that builds the bounded envelope
--     itself and calls `realtime.send(..., private => true)`. It accepts only
--     identifiers, versions and a closed change kind, so no caller can place a
--     field value, file address, permission result or readable label in the
--     payload.
--
-- Wiring a publisher into a specific Record or operation path is a later change;
-- this slice exposes the protected operation for that path to call.

begin;

create schema if not exists vortex_invalidation authorization postgres;

revoke all on schema vortex_invalidation
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant usage on schema vortex_invalidation
  to authenticated, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_invalidation
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_invalidation
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_invalidation
  revoke execute on functions from public, anon, authenticated, service_role;

-- One private Broadcast topic per organisation and application. The runtime
-- formats the same string in `privateInvalidationTopic`; both sides must stay
-- byte-identical: lower-case UUIDs separated by `:` after the
-- `vortex:invalidation` prefix. A null input yields a null topic, which no
-- policy or publisher ever accepts.
create function vortex_invalidation.change_topic(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_organization_id is null or p_application_root_id is null then null
    else 'vortex:invalidation:' || p_organization_id::text || ':' || p_application_root_id::text
  end
$function$;

-- The organisation, and application, named by a well-formed private topic. The
-- pattern accepts exactly the canonical lower-case text form PostgreSQL gives a
-- uuid, so every topic `change_topic` produces parses back to its own inputs. A
-- malformed topic returns null, so it can never authorise anything.
create function vortex_invalidation.topic_organization_id(p_topic text)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_topic ~
      '^vortex:invalidation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then pg_catalog.split_part(p_topic, ':', 3)::uuid
    else null
  end
$function$;

create function vortex_invalidation.topic_application_root_id(p_topic text)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_topic ~
      '^vortex:invalidation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then pg_catalog.split_part(p_topic, ':', 4)::uuid
    else null
  end
$function$;

-- Private owner-only predicate: the application is currently installed in the
-- organisation. This is the same installed-application set the organisation
-- address and default-application setter use
-- (20260924250000_application_address_resolution.sql,
-- 20260924340000_organization_default_application.sql): an active application
-- permission registration owned by an application root of that organisation,
-- with an active installation binding for the exact registered release. A
-- withdrawn registration or detached binding therefore closes the topic.
create function vortex_invalidation.application_is_installed(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null
    and p_application_root_id is not null
    and exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = p_organization_id
            and binding.application_root_id = p_application_root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    )
$function$;

-- The member-read decision for one private topic. The organisation is taken
-- from the verified identity (`auth.uid()` on the Realtime connection, which is
-- the Supabase Auth subject Vortex uses as the identity id) and its own active
-- organisation account, never from the topic string: the topic only selects
-- which of that identity's organisations and installed applications is asked
-- for, so a topic naming another organisation matches no account and is
-- refused. The eligibility mirrors the non-locking probe of
-- vortex_access.resolve_human_organization_scope (active identity projection,
-- account, organisation and tenant), so a suspended or closed identity or
-- account reads nothing. Fine-grained record and page access stays in the
-- ordinary server read path, which the client runs after every invalidation.
create function vortex_invalidation.may_receive_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_projections as projection
    join vortex_identity.organization_accounts as account
      on account.identity_id = projection.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where projection.identity_id = auth.uid()
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
      and organization.organization_id = vortex_invalidation.topic_organization_id(p_topic)
      and vortex_invalidation.application_is_installed(
        organization.organization_id,
        vortex_invalidation.topic_application_root_id(p_topic)
      )
  )
$function$;

-- Supabase owns realtime.messages; this migration only adds the select policy
-- that authorises receiving private Broadcast on a scoped topic. Supabase
-- rechecks it whenever the connection or identity token changes, so a revoked
-- account cannot renew its way to a topic it may no longer open. The policy
-- admits Broadcast only; there is deliberately no insert policy, so a browser
-- can neither send on nor track Presence in these topics.
-- The Realtime service already enables row level security on its own table, and
-- only its owner may run the ALTER, so enable it only when it is somehow off.
do $enable_rls$
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass) then
    alter table realtime.messages enable row level security;
  end if;
end
$enable_rls$;

drop policy if exists vortex_private_invalidation_member_read on realtime.messages;

create policy vortex_private_invalidation_member_read
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and vortex_invalidation.may_receive_topic(realtime.topic())
);

-- The protected post-commit publisher. It takes only identifiers, versions and
-- a closed change kind, verifies the organisation, tenant and exact current
-- application installation, and builds the bounded envelope itself before
-- broadcasting it privately on the deterministic topic. No parameter can add a
-- field value or any other readable content, and the topic is never supplied by
-- the caller. Event name `invalidation` matches
-- `privateInvalidationBroadcastEvent` in runtime/event.
--
-- `realtime.send` only inserts into realtime.messages; Realtime broadcasts the
-- row after the surrounding transaction commits, so a Record or operation path
-- that calls this inside its own transaction emits nothing when it rolls back.
-- When the caller carries a Vortex request context, the notice must belong to
-- that context's organisation, so one organisation's request cannot publish on
-- another organisation's topic.
create function vortex_invalidation.publish_change_notice(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_record_version bigint,
  p_change_kind text,
  p_data_version bigint,
  p_sequence bigint,
  p_correlation_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  selected_topic text;
  selected_payload jsonb;
  stored_context text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or (p_record_id is not null and not vortex_context.is_non_nil_uuid(p_record_id::text))
    or (p_record_version is not null
      and p_record_version not between 1 and 9007199254740991)
    or p_change_kind is null
    or p_change_kind not in ('created', 'changed', 'deleted', 'restored', 'access_changed')
    or p_data_version is null
    or p_data_version not between 1 and 9007199254740991
    or p_sequence is null
    or p_sequence not between 1 and 9007199254740991
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text) then
    raise exception using errcode = '22023',
      message = 'Invalidation notice command is invalid';
  end if;

  stored_context := pg_catalog.current_setting('vortex.request_context', true);
  if stored_context is not null and stored_context <> ''
    and (vortex_context.current_context() ->> 'organizationId')::uuid
      is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Invalidation notice scope is unavailable';
  end if;

  if not exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = p_organization_id
      and organization.state = 'active'
      and tenant.state = 'active'
  ) or not vortex_invalidation.application_is_installed(
    p_organization_id, p_application_root_id
  ) then
    raise exception using errcode = 'P0002',
      message = 'Invalidation notice scope is unavailable';
  end if;

  selected_topic := vortex_invalidation.change_topic(p_organization_id, p_application_root_id);

  selected_payload := pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'recordTypeId', p_record_type_id,
    'changeKind', p_change_kind,
    'dataVersion', p_data_version,
    'sequence', p_sequence,
    'occurredAt', pg_catalog.to_char(operation_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', p_correlation_id
  )
  || case when p_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordId', p_record_id) end
  || case when p_record_version is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('recordVersion', p_record_version) end;

  perform realtime.send(selected_payload, 'invalidation', selected_topic, true);

  return selected_topic;
end
$function$;

revoke all on function vortex_invalidation.change_topic(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.topic_organization_id(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.topic_application_root_id(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.application_is_installed(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.may_receive_topic(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- The Realtime policy runs as `authenticated`, so that role needs exactly the
-- member-read decision. The runtime keeps the publish helper and the topic
-- helpers; `authenticated` gets none of them, and the installed-application
-- predicate stays owner-only.
grant execute on function vortex_invalidation.may_receive_topic(text)
  to authenticated;
grant execute on function vortex_invalidation.change_topic(uuid, uuid)
  to vortex_request, vortex_runtime;
grant execute on function vortex_invalidation.topic_organization_id(text)
  to vortex_request, vortex_runtime;
grant execute on function vortex_invalidation.topic_application_root_id(text)
  to vortex_request, vortex_runtime;
grant execute on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) to vortex_request, vortex_runtime;

comment on schema vortex_invalidation is
  'Private content-free invalidation channel topics, member-read rule and protected Broadcast publisher.';
comment on function vortex_invalidation.change_topic(uuid, uuid) is
  'Returns the deterministic private Broadcast topic for one organisation and application.';
comment on function vortex_invalidation.topic_organization_id(text) is
  'Extracts the organisation from a well-formed private topic, or null.';
comment on function vortex_invalidation.topic_application_root_id(text) is
  'Extracts the application from a well-formed private topic, or null.';
comment on function vortex_invalidation.application_is_installed(uuid, uuid) is
  'Private check that an application has an active registration and an active installation binding for its registered release in one organisation.';
comment on function vortex_invalidation.may_receive_topic(text) is
  'Authorises one authenticated identity to read a private topic only for an active organisation account it holds and an application currently installed there.';
comment on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) is
  'Protected post-commit broadcast of the bounded content-free invalidation envelope on the private topic for one organisation and application.';

commit;
