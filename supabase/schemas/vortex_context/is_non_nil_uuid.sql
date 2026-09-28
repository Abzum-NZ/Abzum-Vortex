create or replace function vortex_context.is_non_nil_uuid(candidate text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $function$
  select
    coalesce(
      candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and candidate <> '00000000-0000-0000-0000-000000000000',
      false
    )
$function$;

revoke execute on function vortex_context.is_non_nil_uuid(text)
  from public, anon, authenticated, service_role;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter,
    vortex_module_owner, vortex_access_owner, vortex_workflow_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_file_owner;

comment on function vortex_context.is_non_nil_uuid(text) is
  'Accepts only a non-nil RFC UUID with a version nibble from 1 through 8 and an RFC variant nibble.';
