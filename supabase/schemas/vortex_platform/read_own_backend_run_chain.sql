create or replace function vortex_platform.read_own_backend_run_chain(p_backend_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  caller_account uuid;
  caller_organization uuid;
  caller_application uuid;
  follow uuid := p_backend_run_id;
  current_run record;
  pages integer := 0;
  chain_state text := 'running';
  failure text;
begin
  if p_backend_run_id is null or not vortex_platform.is_non_nil_uuid(p_backend_run_id::text) then
    raise exception using errcode = '22023', message = 'Back-end run request is invalid';
  end if;
  -- The caller, the organisation and the application come only from the validated request context.
  checked := vortex_access.validated_human_request_context();
  if not (checked ?& array['organizationId', 'organizationAccountId', 'applicationRootId'])
    or not vortex_platform.is_non_nil_uuid(checked ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Back-end run is unavailable';
  end if;
  caller_organization := (checked ->> 'organizationId')::uuid;
  caller_account := (checked ->> 'organizationAccountId')::uuid;
  caller_application := (checked ->> 'applicationRootId')::uuid;

  -- A run chain is the run and every run its outputs name as `next`; only runs the caller started
  -- in this application are read, and only their state, never their outputs.
  loop
    select run.state, run.failure_code, run.outputs ->> 'next' as next_run
    into current_run
    from vortex_platform.backend_runs as run
    where run.backend_run_id = follow
      and run.organization_id = caller_organization
      and run.application_root_id = caller_application
      and run.actor_id = caller_account;
    if not found then
      -- The first run is not the caller's (or does not exist): nothing is told about it.
      if pages = 0 then
        return pg_catalog.jsonb_build_object('kind', 'refused');
      end if;
      exit;
    end if;
    pages := pages + 1;
    if current_run.state in ('refused', 'failed') then
      chain_state := 'failed';
      failure := coalesce(current_run.failure_code, current_run.state);
      exit;
    end if;
    if current_run.state <> 'succeeded' then
      exit;
    end if;
    if current_run.next_run is null or not vortex_platform.is_non_nil_uuid(current_run.next_run) then
      chain_state := 'succeeded';
      exit;
    end if;
    if pages = 1000 then
      chain_state := 'failed';
      failure := 'chain_too_long';
      exit;
    end if;
    follow := current_run.next_run::uuid;
  end loop;
  return pg_catalog.jsonb_build_object(
    'kind', 'read', 'state', chain_state, 'pages', pages, 'failureCode', failure
  );
end
$function$;
alter function vortex_platform.read_own_backend_run_chain(uuid) owner to vortex_owner;

revoke all on function vortex_platform.read_own_backend_run_chain(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_own_backend_run_chain(uuid)
  to vortex_request;

comment on function vortex_platform.read_own_backend_run_chain(uuid) is
  'Reads where a back-end run the caller started has got to, following the runs it started after itself: running, succeeded or failed, the number of runs and the failure code, never outputs; any run that is not the caller''s own in the selected application is refused.';
