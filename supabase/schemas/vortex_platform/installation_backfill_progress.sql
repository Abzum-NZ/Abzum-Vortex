create or replace function vortex_platform.installation_backfill_progress(
  p_occurrence_id uuid, p_claim_cursor uuid, p_checkpoint jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  progress vortex_platform.consumer_occurrence_progress%rowtype;
  installed_revision bigint;
  settings jsonb;
begin
  context_value := vortex_access.derived_backfill_context_internal();
  -- The claim token is fenced by the existing dispatcher lease. Lock it through the
  -- record writes and checkpoint commit so a concurrent recovery cannot advance it.
  select claimed.* into progress
  from vortex_platform.consumer_occurrence_progress as claimed
  join vortex_platform.event_outbox as occurrence using (occurrence_id)
  where claimed.consumer_key = 'installation-derived-values'
    and claimed.occurrence_id = p_occurrence_id
    and claimed.claim_cursor = p_claim_cursor
    and claimed.acknowledged_at is null and claimed.terminally_failed_at is null
    and claimed.lease_expires_at > pg_catalog.clock_timestamp()
    and occurrence.occurrence_kind = 'installation_activated'
    and occurrence.organization_id = (context_value ->> 'organizationId')::uuid
    and occurrence.sequence_application_root_id = (context_value ->> 'applicationRootId')::uuid
  for update of claimed;
  if not found then
    raise exception using errcode = '40001', message = 'Installation backfill claim is unavailable';
  end if;

  -- Lock the installation using the lifecycle writer's canonical binding locks. A page
  -- either commits before the switch/detach or sees it; never writes through stale mappings.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'vortex_definition.binding:' || binding.organization_id::text || ':' ||
    binding.application_root_id::text || ':' || binding.module_root_id::text, 0
  ))
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
  order by binding.module_root_id;
  select pg_catalog.min(binding.application_release_revision) into installed_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and binding.state = 'active';

  if p_checkpoint is not null then
    if pg_catalog.jsonb_typeof(p_checkpoint) is distinct from 'object'
      or not p_checkpoint ?& array['releaseRevision', 'recordTypeId', 'afterRecordId',
        'processedCount', 'writtenCount', 'complete']
      or p_checkpoint - array['releaseRevision', 'recordTypeId', 'afterRecordId',
        'processedCount', 'writtenCount', 'complete'] <> '{}'::jsonb
      or (p_checkpoint ->> 'releaseRevision')::bigint is distinct from installed_revision
      or pg_catalog.jsonb_typeof(p_checkpoint -> 'complete') is distinct from 'boolean'
      or (p_checkpoint ->> 'processedCount')::bigint < 0
      or (p_checkpoint ->> 'writtenCount')::bigint < 0 then
      raise exception using errcode = '22023', message = 'Installation backfill checkpoint is invalid';
    end if;
    update vortex_platform.consumer_occurrence_progress
    set checkpoint = p_checkpoint,
      -- Successful pages do not spend the failure budget. The next ordinary dispatcher
      -- claim continues this occurrence; there is no second lease or retry mechanism.
      attempt_count = 0, failure_count = 0, last_failed_at = null, last_failure_code = null,
      lease_expires_at = case when (p_checkpoint ->> 'complete')::boolean
        then lease_expires_at else greatest(
          pg_catalog.clock_timestamp(), claimed_at + interval '1 microsecond') end
    where consumer_key = progress.consumer_key and occurrence_id = progress.occurrence_id;
    return p_checkpoint;
  end if;
  select pg_catalog.jsonb_build_object('timeZone', configured.time_zone, 'currency', configured.currency)
  into settings
  from vortex_identity.read_current_organization_runtime_settings_internal(
    (context_value ->> 'organizationId')::uuid
  ) as configured;
  if settings is null then
    raise exception using errcode = '55000', message = 'Installation backfill settings are unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'checkpoint', progress.checkpoint, 'releaseRevision', installed_revision, 'settings', settings
  );
end
$function$;
alter function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb)
  to vortex_request, postgres;
