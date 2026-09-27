create or replace function vortex_module.remove_abandoned_runtime_bundles_internal(
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  abandoned_bundle_ttl constant interval := interval '7 days';
  maximum_batch_size constant integer := 100;
  candidate_key record;
  bundle_row vortex_module.installation_runtime_bundles%rowtype;
  removed_bundle_keys jsonb := '[]'::jsonb;
  bundles_removed bigint := 0;
  bundle_parts_removed bigint := 0;
  access_plans_removed bigint := 0;
  orphaned_access_plans_removed bigint := 0;
  changed_rows bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > maximum_batch_size then
    raise exception using errcode = '22023',
      message = 'Runtime bundle cleanup batch is invalid';
  end if;

  for candidate_key in
    select bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    from vortex_module.installation_runtime_bundles as bundle
    where not exists (
      select 1
      from vortex_module.installation_bindings as binding
      where binding.organization_id = bundle.organization_id
        and binding.application_root_id = bundle.application_root_id
        and binding.application_release_revision = bundle.application_release_revision
        and binding.state in ('active', 'draining')
    )
      and (
        exists (
          select 1
          from vortex_module.installation_bindings as later_binding
          where later_binding.organization_id = bundle.organization_id
            and later_binding.application_root_id = bundle.application_root_id
            and later_binding.application_release_revision > bundle.application_release_revision
            and later_binding.state in ('active', 'draining')
        )
        or (
          bundle.built_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
          and exists (
            select 1
            from vortex_module.installation_bindings as candidate_binding
            where candidate_binding.organization_id = bundle.organization_id
              and candidate_binding.application_root_id = bundle.application_root_id
              and candidate_binding.application_release_revision = bundle.application_release_revision
              and candidate_binding.state = 'provisioned'
          )
          and not exists (
            select 1
            from vortex_module.installation_bindings as candidate_binding
            where candidate_binding.organization_id = bundle.organization_id
              and candidate_binding.application_root_id = bundle.application_root_id
              and candidate_binding.application_release_revision = bundle.application_release_revision
              and candidate_binding.state <> 'provisioned'
          )
        )
      )
    order by bundle.built_at, bundle.organization_id, bundle.application_root_id,
      bundle.application_release_revision, bundle.bundle_format_version
    limit p_limit
  loop
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = candidate_key.organization_id
      and binding.application_root_id = candidate_key.application_root_id
    order by binding.module_root_id
    for update;

    select bundle.* into bundle_row
    from vortex_module.installation_runtime_bundles as bundle
    where bundle.organization_id = candidate_key.organization_id
      and bundle.application_root_id = candidate_key.application_root_id
      and bundle.application_release_revision = candidate_key.application_release_revision
      and bundle.bundle_format_version = candidate_key.bundle_format_version
    for update of bundle skip locked;
    if not found then
      continue;
    end if;

    if exists (
      select 1
      from vortex_module.installation_bindings as binding
      where binding.organization_id = bundle_row.organization_id
        and binding.application_root_id = bundle_row.application_root_id
        and binding.application_release_revision = bundle_row.application_release_revision
        and binding.state in ('active', 'draining')
    ) then
      continue;
    end if;

    if not exists (
        select 1
        from vortex_module.installation_bindings as later_binding
        where later_binding.organization_id = bundle_row.organization_id
          and later_binding.application_root_id = bundle_row.application_root_id
          and later_binding.application_release_revision > bundle_row.application_release_revision
          and later_binding.state in ('active', 'draining')
      ) and not (
        bundle_row.built_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
        and exists (
          select 1
          from vortex_module.installation_bindings as candidate_binding
          where candidate_binding.organization_id = bundle_row.organization_id
            and candidate_binding.application_root_id = bundle_row.application_root_id
            and candidate_binding.application_release_revision = bundle_row.application_release_revision
            and candidate_binding.state = 'provisioned'
        )
        and not exists (
          select 1
          from vortex_module.installation_bindings as candidate_binding
          where candidate_binding.organization_id = bundle_row.organization_id
            and candidate_binding.application_root_id = bundle_row.application_root_id
            and candidate_binding.application_release_revision = bundle_row.application_release_revision
            and candidate_binding.state <> 'provisioned'
        )
      ) then
      continue;
    end if;

    delete from vortex_module.installation_runtime_bundle_parts as part
    where part.organization_id = bundle_row.organization_id
      and part.application_root_id = bundle_row.application_root_id
      and part.application_release_revision = bundle_row.application_release_revision
      and part.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    bundle_parts_removed := bundle_parts_removed + changed_rows;

    delete from vortex_module.installation_runtime_bundles as bundle
    where bundle.organization_id = bundle_row.organization_id
      and bundle.application_root_id = bundle_row.application_root_id
      and bundle.application_release_revision = bundle_row.application_release_revision
      and bundle.bundle_format_version = bundle_row.bundle_format_version;
    get diagnostics changed_rows = row_count;
    if changed_rows = 1 then
      bundles_removed := bundles_removed + 1;
      removed_bundle_keys := removed_bundle_keys || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'organizationId', bundle_row.organization_id,
          'applicationRootId', bundle_row.application_root_id,
          'applicationReleaseRevision', bundle_row.application_release_revision
        )
      );
    end if;
  end loop;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(removed_bundle_keys) as removed(bundle_key)
      where (removed.bundle_key ->> 'organizationId')::uuid = candidate.organization_id
        and (removed.bundle_key ->> 'applicationRootId')::uuid = candidate.application_root_id
        and (removed.bundle_key ->> 'applicationReleaseRevision')::bigint =
          candidate.application_release_revision
    )
      and not exists (
        select 1
        from vortex_module.installation_runtime_bundles as remaining
        where remaining.organization_id = candidate.organization_id
          and remaining.application_root_id = candidate.application_root_id
          and remaining.application_release_revision = candidate.application_release_revision
      )
      and not exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state in ('active', 'draining')
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  access_plans_removed := access_plans_removed + changed_rows;

  delete from vortex_record.installation_access_plans as plan
  where plan.plan_key in (
    select candidate.plan_key
    from vortex_record.installation_access_plans as candidate
    where not exists (
      select 1
      from vortex_module.installation_runtime_bundles as bundle
      where bundle.organization_id = candidate.organization_id
        and bundle.application_root_id = candidate.application_root_id
        and bundle.application_release_revision = candidate.application_release_revision
    )
      and not exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = candidate.organization_id
          and binding.application_root_id = candidate.application_root_id
          and binding.application_release_revision = candidate.application_release_revision
          and binding.state in ('active', 'draining')
      )
    order by candidate.plan_key
    limit p_limit
  );
  get diagnostics changed_rows = row_count;
  orphaned_access_plans_removed := changed_rows;

  return pg_catalog.jsonb_build_object(
    'bundlesRemoved', bundles_removed,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed,
    'orphanedAccessPlansRemoved', orphaned_access_plans_removed
  );
end
$function$;

alter function vortex_module.remove_abandoned_runtime_bundles_internal(integer)
  owner to vortex_module_owner;
revoke all on function vortex_module.remove_abandoned_runtime_bundles_internal(integer)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.remove_abandoned_runtime_bundles_internal(integer)
  to vortex_runtime;
comment on function vortex_module.remove_abandoned_runtime_bundles_internal(integer) is
  'Removes one bounded batch of expired never-activated or superseded runtime bundles and orphaned access plans.';
