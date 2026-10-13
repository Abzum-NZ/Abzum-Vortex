CREATE FUNCTION vortex_identity.protect_identity_disablement_command() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'identity disablement records are append-only'
      using errcode = '55000';
  end if;
  if new.command_id is distinct from old.command_id
    or new.actor_identity_id is distinct from old.actor_identity_id
    or new.subject_identity_id is distinct from old.subject_identity_id
    or new.command_fingerprint is distinct from old.command_fingerprint
    or new.correlation_id is distinct from old.correlation_id
    or new.requested_at is distinct from old.requested_at
    or old.outcome = 'disabled'
  then
    raise exception 'a recorded identity disablement command identity and result are immutable'
      using errcode = '55000';
  end if;
  return new;
end
$$;

alter function vortex_identity.protect_identity_disablement_command() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_identity_disablement_command() FROM PUBLIC;

grant execute on function vortex_identity.protect_identity_disablement_command() to postgres;
