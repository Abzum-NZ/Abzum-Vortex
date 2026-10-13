CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Organization roles cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.role_id is distinct from old.role_id
    or new.role_kind is distinct from old.role_kind
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or new.derived_application_root_id is distinct from old.derived_application_root_id
    or new.derived_source_role_id is distinct from old.derived_source_role_id
    or new.derived_source_definition_key is distinct from old.derived_source_definition_key
    or new.derived_source_release_revision is distinct from old.derived_source_release_revision
    or new.derived_source_release_version is distinct from old.derived_source_release_version
    or new.derived_source_validation_contract_version is distinct
      from old.derived_source_validation_contract_version
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or old.live_revision = 9007199254740991
    or new.live_revision <> old.live_revision + 1 then
    raise exception using errcode = '23514',
      message = 'Organization role updates require one permanent-identity revision';
  end if;

  return new;
end;
$$;

ALTER FUNCTION vortex_access.protect_organization_role_identity() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_identity() FROM PUBLIC;
