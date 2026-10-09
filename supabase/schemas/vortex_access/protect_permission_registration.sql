create or replace function vortex_access.protect_permission_registration()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  target record;
  target_history vortex_access.permission_registration_revisions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission registrations cannot be deleted';
  end if;
  if tg_op <> 'UPDATE'
    or new.organization_id is distinct from old.organization_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;

  if new.registration_kind = 'platform' and new.revision >= 7 then
    if new.registration_owner_id is distinct from platform_owner_id
      or old.state is distinct from 'active' or new.state is distinct from 'active'
      or new.revision not between 7 and 9007199254740991
      or new.revision <= old.revision
      or new.source_definition_key is not null
      or new.source_revision is not null
      or new.validation_contract_version is not null
      or new.source_content_fingerprint is not null
      or new.source_resolution_fingerprint is not null then
      raise exception using errcode = '23514', message = 'Permission registration declared target is invalid';
    end if;

    -- R already holds Access then registration locks. This fixed owner capability
    -- also keeps any other protected platform update on a stable declaration set.
    perform vortex_access.lock_platform_permission_declaration_catalogue_internal();
    select pg_catalog.count(*) as entry_count,
      pg_catalog.count(distinct declaration.permission_id) as distinct_permission_ids,
      pg_catalog.count(distinct declaration.permission_key) as distinct_permission_keys,
      pg_catalog.count(distinct declaration.declared_current_revision) as distinct_declared_targets,
      pg_catalog.count(distinct declaration.registration_revision) as distinct_revisions,
      pg_catalog.count(distinct declaration.source_version) as distinct_versions,
      pg_catalog.count(distinct declaration.catalogue_fingerprint) as distinct_fingerprints,
      pg_catalog.min(declaration.declared_current_revision) as declared_current_revision,
      pg_catalog.min(declaration.registration_revision) as registration_revision,
      pg_catalog.min(declaration.source_version) as source_version,
      pg_catalog.min(declaration.catalogue_fingerprint) as catalogue_fingerprint
    into target
    from vortex_access.read_platform_permission_declaration_catalogue_internal(null::bigint) as declaration;
    if target.entry_count = 0
      or target.entry_count <> target.distinct_permission_ids
      or target.entry_count <> target.distinct_permission_keys
      or target.distinct_declared_targets <> 1 or target.distinct_revisions <> 1
      or target.distinct_versions <> 1 or target.distinct_fingerprints <> 1
      or target.declared_current_revision is distinct from new.revision
      or target.registration_revision is distinct from new.revision
      or target.source_version is distinct from new.source_version
      or target.catalogue_fingerprint is distinct from new.permission_catalogue_fingerprint
      or target.catalogue_fingerprint is distinct from new.candidate_fingerprint then
      raise exception using errcode = '23514', message = 'Permission registration declared target is invalid';
    end if;

    select history.* into target_history
    from vortex_access.permission_registration_revisions as history
    where history.organization_id = new.organization_id
      and history.registration_kind = 'platform'
      and history.registration_owner_id = platform_owner_id
      and history.revision = new.revision;
    if not found
      or target_history.operation is distinct from 'platform_metadata_revision'
      or row(target_history.state, target_history.source_definition_key,
        target_history.source_version, target_history.source_revision,
        target_history.validation_contract_version,
        target_history.source_content_fingerprint, target_history.source_resolution_fingerprint,
        target_history.permission_catalogue_fingerprint, target_history.candidate_fingerprint,
        target_history.changed_at, target_history.changed_by, target_history.change_correlation_id)
      is distinct from row(new.state, new.source_definition_key,
        new.source_version, new.source_revision, new.validation_contract_version,
        new.source_content_fingerprint, new.source_resolution_fingerprint,
        new.permission_catalogue_fingerprint, new.candidate_fingerprint,
        new.changed_at, new.changed_by, new.change_correlation_id) then
      raise exception using errcode = '23514', message = 'Permission registration declared target history is invalid';
    end if;
    -- Do not invoke current-only exactness here: the BEFORE UPDATE pointer is OLD.
    -- R validates the complete target entries and continuities after publication.
  elsif new.revision <> old.revision + 1 then
    raise exception using errcode = '23514', message = 'Permission registration updates require one permanent-scope revision';
  end if;
  return new;
end
$function$;

revoke execute on function vortex_access.protect_permission_registration()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
comment on function vortex_access.protect_permission_registration() is
  'Preserves permanent registration scope and monotonic attribution; Application and historical platform transitions remain consecutive, while fixed-platform declared targets require exact protected target and immutable history evidence.';
alter function vortex_access.protect_permission_registration() owner to postgres;
