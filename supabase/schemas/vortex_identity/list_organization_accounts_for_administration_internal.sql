create or replace function vortex_identity.list_organization_accounts_for_administration_internal(
  p_organization_id uuid,
  p_after_organization_account_id uuid,
  p_page_size integer
)
returns table (
  accounts jsonb,
  next_after_organization_account_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_items jsonb;
  page_account_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration page input is invalid';
  end if;

  with candidates as (
    select account.organization_account_id, account.display_name,
      account.state, account.language, account.time_zone, account.revision,
      pg_catalog.row_number() over (
        order by account.organization_account_id
      ) as ordinal
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and (
        p_after_organization_account_id is null
        or account.organization_account_id > p_after_organization_account_id
      )
    order by account.organization_account_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'organizationAccountId', candidate.organization_account_id,
          'displayName', candidate.display_name,
          'state', candidate.state,
          'language', candidate.language,
          'timeZone', candidate.time_zone,
          'revision', candidate.revision
        )) order by candidate.organization_account_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.organization_account_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into account_items, page_account_ids, candidate_count
  from candidates as candidate;

  return query select account_items,
    case when candidate_count > p_page_size
      then page_account_ids[p_page_size] else null end;
end
$function$;

revoke all on function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_accounts_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe account administration projection.';

alter function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) to postgres;
reset role;
