-- People and invitations as system records (#1031).
--
-- A system projection record type is a read-only projection over protected core
-- storage: its typed fields project one registered protected view, it has no
-- ordinary create, update, delete or restore path, and every change goes through
-- a named protected operation. This migration registers the person (organisation
-- account) and organisation-invitation projections and their readers, so the
-- ordinary query path reads them exactly as the #1030 organisation
-- runtime-settings projection is read.
--
-- Row visibility stays inside each registered reader: the person projection
-- applies the fixed accounts.read decision and the invitation projection applies
-- the fixed invitations.read decision. The readers are registered in the closed
-- vortex_record.protected_read_model_views registry, so storage provisioning can
-- only ever catalogue them under their exact declared key. The raw invitation
-- secret and its stored fingerprint are never projected.

begin;

-- ============================================================================
-- Identity-owned set-returning safe projections. Each receives one already
-- decided organisation scope and never sees the caller's request context.
-- ============================================================================

create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select account.organization_account_id, account.display_name, account.state,
    account.language, account.time_zone, account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  order by account.organization_account_id
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid) is
  'Identity-owned set-returning safe organisation-account projection bounded to the given organisation: identity, originating invitation and state-change evidence are never exposed, and the already-decided request scope is the only visibility.';

create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid
)
returns table (
  invitation_id uuid,
  invited_email text,
  invitation_state text,
  invited_at timestamptz,
  expires_at timestamptz,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select invitation.invitation_id, invitation.invited_email,
    case
      when invitation.accepted_at is not null then 'accepted'
      when invitation.revoked_at is not null then 'revoked'
      when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
      else 'pending'
    end,
    invitation.invited_at, invitation.expires_at, invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  order by invitation.invitation_id
$function$;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_invitations_projection_internal(uuid) is
  'Identity-owned set-returning safe organisation-invitation projection bounded to the given organisation: the raw invitation secret and its stored fingerprint are never exposed, and the already-decided request scope is the only visibility.';

-- ============================================================================
-- Access-registered projection readers. One reader per protected read-model
-- key, applying that read model's own fixed decision and returning the
-- organisation, the projected row identity, the projected revision and the
-- projected safe attribute values for the current viewer.
-- ============================================================================

create or replace function vortex_access.list_organization_accounts_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- accounts.read decision the bespoke administration reader applies decides
  -- whether the viewer sees any account at all, and the caller's current
  -- organisation is never an input. A viewer the decision refuses sees no rows,
  -- exactly as a missing or foreign record, so the record adapters return their
  -- identical refusal and a list page is empty rather than failing. The record
  -- identity is the organisation account, the revision is the account's own
  -- revision and the attribute names are the lowercase field keys a projection
  -- record type declares. The raw identity, invitation link and state-change
  -- evidence stay in the protected storage and are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_accounts_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.organization_account_id,
    projected.revision,
    pg_catalog.jsonb_build_object(
      'display_name', projected.display_name,
      'state', projected.account_state,
      'language', projected.language,
      'time_zone', projected.time_zone
    )
  from vortex_identity.list_organization_accounts_projection_internal(
    scope_row.organization_id
  ) as projected
  where p_record_id is null or p_record_id = projected.organization_account_id;
end
$function$;

revoke all on function vortex_access.list_organization_accounts_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_accounts_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_accounts_projection(uuid, integer) is
  'Registered organisation-account projection: returns every account the current viewer may read under the fixed accounts.read decision, with the organisation, the account identity, the account revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer.';

create or replace function vortex_access.list_organization_invitations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- invitations.read decision the bespoke administration reader applies decides
  -- whether the viewer sees any invitation at all, and the caller's current
  -- organisation is never an input. A viewer the decision refuses sees no rows,
  -- exactly as a missing or foreign record. The record identity is the
  -- invitation, the revision is the invitation's own revision and the attribute
  -- names are the lowercase field keys a projection record type declares. The
  -- raw invitation secret and its stored fingerprint are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_invitations_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.invitation_id,
    projected.revision,
    pg_catalog.jsonb_build_object(
      'invited_email', projected.invited_email,
      'state', projected.invitation_state,
      'invited_at', projected.invited_at,
      'expires_at', projected.expires_at
    )
  from vortex_identity.list_organization_invitations_projection_internal(
    scope_row.organization_id
  ) as projected
  where p_record_id is null or p_record_id = projected.invitation_id;
end
$function$;

revoke all on function vortex_access.list_organization_invitations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_invitations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_invitations_projection(uuid, integer) is
  'Registered organisation-invitation projection: returns every invitation the current viewer may read under the fixed invitations.read decision, with the organisation, the invitation identity, the invitation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. The secret and fingerprint are never projected.';

-- ============================================================================
-- Register the two readers under their exact closed keys, so a projection
-- record type can only ever be catalogued against the reader registered here.
-- ============================================================================

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function
) values
  ('organization_accounts', 'vortex_access', 'list_organization_accounts_projection'),
  ('organization_invitations', 'vortex_access', 'list_organization_invitations_projection');

commit;
