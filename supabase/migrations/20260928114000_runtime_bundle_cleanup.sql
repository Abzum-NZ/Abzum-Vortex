-- #1499: remove abandoned and superseded runtime bundles through bounded maintenance and uninstall.
--
-- The Module owner receives narrowly scoped access to the cached Record access-plan table so its
-- bundle cleanup can remove plans with their owning registrations. Runtime callers can execute
-- only the bounded maintenance function; uninstall cleanup remains request-scoped and authority
-- checked.

begin;

set local role vortex_record_owner;
grant usage on schema vortex_record to vortex_module_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
grant select, delete on table vortex_record.installation_access_plans to vortex_module_owner;
create index installation_access_plans_bundle_cleanup_idx
  on vortex_record.installation_access_plans (
    organization_id, application_root_id, application_release_revision, plan_key
  );
create policy installation_access_plans_module_bundle_cleanup
  on vortex_record.installation_access_plans to vortex_module_owner
  using (true) with check (true);
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

set local role vortex_module_owner;
grant usage on schema vortex_module to vortex_runtime;
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
          and not exists (
            select 1
            from vortex_module.installation_bindings as previous_binding
            where previous_binding.organization_id = bundle.organization_id
              and previous_binding.application_root_id = bundle.application_root_id
              and previous_binding.application_release_revision = bundle.application_release_revision
              and previous_binding.state = 'detached'
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
      ) and (
        bundle_row.built_at > pg_catalog.statement_timestamp() - abandoned_bundle_ttl
        or exists (
          select 1
          from vortex_module.installation_bindings as previous_binding
          where previous_binding.organization_id = bundle_row.organization_id
            and previous_binding.application_root_id = bundle_row.application_root_id
            and previous_binding.application_release_revision = bundle_row.application_release_revision
            and previous_binding.state = 'detached'
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
    where candidate.created_at <= pg_catalog.statement_timestamp() - abandoned_bundle_ttl
      and not exists (
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

create or replace function vortex_module.remove_installation_runtime_bundles_internal(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  bundle_list jsonb;
  bundles_removed bigint;
  bundle_parts_removed bigint;
  access_plans_removed bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Runtime bundle uninstall command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  perform 1
  from vortex_module.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id
  order by binding.module_root_id
  for update;

  if exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state in ('active', 'draining')
  ) then
    raise exception using errcode = '40001',
      message = 'Runtime bundles cannot be removed before installation drain completes';
  end if;

  delete from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = authority.organization_id
    and part.application_root_id = p_application_root_id;
  get diagnostics bundle_parts_removed = row_count;

  with removed_bundles as (
    delete from vortex_module.installation_runtime_bundles as bundle
    where bundle.organization_id = authority.organization_id
      and bundle.application_root_id = p_application_root_id
    returning bundle.application_release_revision, bundle.bundle_format_version
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationReleaseRevision', removed.application_release_revision,
          'bundleFormatVersion', removed.bundle_format_version
        ) order by removed.application_release_revision, removed.bundle_format_version
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)
  into bundle_list, bundles_removed
  from removed_bundles as removed;

  delete from vortex_record.installation_access_plans as plan
  where plan.organization_id = authority.organization_id
    and plan.application_root_id = p_application_root_id;
  get diagnostics access_plans_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'bundles', bundle_list,
    'bundlePartsRemoved', bundle_parts_removed,
    'accessPlansRemoved', access_plans_removed
  );
end
$function$;

alter function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.remove_installation_runtime_bundles_internal(uuid)
  to vortex_request;
comment on function vortex_module.remove_installation_runtime_bundles_internal(uuid) is
  'Lists and removes all runtime bundle registrations and access plans for one authorised installation after its bindings are detached.';

reset role;

commit;
