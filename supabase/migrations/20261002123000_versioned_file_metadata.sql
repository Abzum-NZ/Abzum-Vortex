begin;

alter table vortex_file.file_records
  add column metadata_revision bigint not null default 1,
  add constraint file_records_metadata_revision_safe_integer
    check (metadata_revision between 1 and 9007199254740991);

comment on column vortex_file.file_records.metadata_revision is
  'Monotonic File metadata revision, independent of upload reservation revisions.';

create or replace function vortex_file.advance_file_metadata_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.metadata_revision is distinct from 1 then
      raise exception using
        errcode = '22023',
        message = 'File metadata revision must start at one';
    end if;
    new.metadata_revision := 1;
    return new;
  end if;

  if new.metadata_revision is distinct from old.metadata_revision then
    raise exception using
      errcode = '22023',
      message = 'File metadata revision is managed by the File metadata trigger';
  end if;

  if old.metadata_revision >= 9007199254740991 then
    raise exception using
      errcode = '22003',
      message = 'File metadata revision is exhausted';
  end if;

  new.metadata_revision := old.metadata_revision + 1;
  return new;
end
$function$;

revoke execute on function vortex_file.advance_file_metadata_revision()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_file.advance_file_metadata_revision() is
  'Maintains the File metadata revision on each file record insert or update.';

alter function vortex_file.advance_file_metadata_revision() owner to postgres;

create trigger file_records_advance_metadata_revision
before insert or update on vortex_file.file_records
for each row execute function vortex_file.advance_file_metadata_revision();

comment on trigger file_records_advance_metadata_revision on vortex_file.file_records is
  'Initializes and advances the stored File metadata revision for each row write.';

set local role vortex_file_owner;

create or replace function vortex_file.read_versioned_file_metadata(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  established jsonb := vortex_context.validated_service_context();
  stored vortex_file.file_records%rowtype;
begin
  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = (established ->> 'organizationId')::uuid;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'revision', stored.metadata_revision,
    'fileRecord', vortex_file.upload_file_record(stored)
  );
end
$function$;

revoke execute on function vortex_file.read_versioned_file_metadata(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.read_versioned_file_metadata(uuid) to vortex_request;

comment on function vortex_file.read_versioned_file_metadata(uuid) is
  'Reads one organization-scoped File metadata revision and its canonical FileRecord projection.';

alter function vortex_file.read_versioned_file_metadata(uuid) owner to vortex_file_owner;

reset role;

commit;
