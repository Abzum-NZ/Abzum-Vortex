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
