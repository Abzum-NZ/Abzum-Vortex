create or replace function vortex_platform.grid_view_visible_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid,
  p_page_id uuid,
  p_placement_id uuid,
  p_view_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_platform.grid_views as candidate
    cross join lateral vortex_platform.grid_view_viewer_targets_internal(
      p_organization_id, p_organization_account_id, p_application_root_id
    ) as targets
    where candidate.view_id = p_view_id
      and candidate.organization_id = p_organization_id
      and candidate.application_root_id = p_application_root_id
      and candidate.page_id = p_page_id
      and candidate.placement_id = p_placement_id
      and candidate.kind = 'named_view'
      and (candidate.organization_account_id = p_organization_account_id
        or (candidate.scope = 'shared'
          and (candidate.share_organization
            or candidate.share_role_ids && targets.role_ids
            or candidate.share_group_ids && targets.group_ids)))
  )
$function$;

revoke all on function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid) is
  'Whether the account owns the named grid view or it is shared with them now; owner-only.';

alter function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid)
  owner to vortex_owner;
