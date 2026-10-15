create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid, p_record_ids uuid[], p_sort_key text,
  p_direction text, p_after jsonb, p_limit integer
)
returns table (
  invitation_id uuid, invited_email text, invitation_state text,
  invited_at timestamptz, expires_at timestamptz, revision bigint
)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  sort_column text;
  keyset_sql text := '';
  order_sql text;
  after_text text;
  after_expires_at timestamptz;
  after_record_id uuid;
  scan_sql text;
begin
  if p_sort_key not in ('record_id', 'invited_email', 'expires_at')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Invitation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'invited_email' then 'invitation.invited_email'
    when 'expires_at' then 'invitation.expires_at'
    else 'invitation.invitation_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Invitation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if p_sort_key = 'expires_at' then
        after_expires_at := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Invitation projection cursor is invalid';
    end;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and invitation.invitation_id > $4'
        else ' and invitation.invitation_id < $4' end;
    elsif p_sort_key = 'invited_email' then
      keyset_sql := pg_catalog.format(
        ' and (invitation.invited_email collate "C", invitation.invitation_id) %s ($3 collate "C", $4)',
        case when p_direction = 'ascending' then '>' else '<' end
      );
    else
      keyset_sql := pg_catalog.format(
        ' and (invitation.expires_at, invitation.invitation_id) %s ($5, $4)',
        case when p_direction = 'ascending' then '>' else '<' end
      );
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('invitation.invitation_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s%s %s, invitation.invitation_id %s',
      sort_column, case when p_sort_key = 'invited_email' then ' collate "C"' else '' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  scan_sql := $scan$
    select invitation.invitation_id, invitation.invited_email,
      case
        when invitation.accepted_at is not null then 'accepted'
        when invitation.revoked_at is not null then 'revoked'
        when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
        else 'pending'
      end,
      invitation.invited_at, invitation.expires_at, invitation.revision
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = $1
      and $1 is not null
      and $1 <> '00000000-0000-0000-0000-000000000000'::uuid
      and ($2 is null or invitation.invitation_id = any($2))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $6', order_sql);
  return query execute scan_sql using p_organization_id, p_record_ids,
    after_text, after_record_id, after_expires_at, p_limit;
end
$function$;

create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid
)
returns table (
  invitation_id uuid, invited_email text, invitation_state text,
  invited_at timestamptz, expires_at timestamptz, revision bigint
)
language sql stable security definer set search_path = ''
as $function$
  select projected.*
  from vortex_identity.list_organization_invitations_projection_internal(
    p_organization_id, null, 'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_identity.list_organization_invitations_projection_internal(uuid) is
  'Identity-owned safe organisation-invitation projection with the original record-id ordering; delegates to the bounded scan.';
alter function vortex_identity.list_organization_invitations_projection_internal(uuid) owner to vortex_owner;
grant execute on function vortex_identity.list_organization_invitations_projection_internal(uuid) to postgres;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer
) to vortex_owner, postgres;
alter function vortex_identity.list_organization_invitations_projection_internal(
  uuid, uuid[], text, text, jsonb, integer
) owner to vortex_owner;
