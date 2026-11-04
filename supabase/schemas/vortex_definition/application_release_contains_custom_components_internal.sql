-- Whether an Application release places a platform block that is not one of the built-in blocks.
-- A custom component is a platform block release registered outside the built-in catalogue, and the
-- stored dependency manifest names every platform block a release places. Any block the built-in
-- list below does not hold therefore counts, so a block the database does not know can never skip
-- the custom code permission and recent sign-in that installing custom code needs. A built-in block
-- added to the platform block catalogue (application-composition-catalogue.source.json) is added to
-- this list in the same change.
create or replace function vortex_definition.application_release_contains_custom_components_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_definition.release_dependencies as dependency
    where dependency.root_id = p_application_root_id
      and dependency.release_revision = p_application_release_revision
      and dependency.dependency_kind = 'platform_block'
      and dependency.catalogue_item_id <> all (array[
        '11d1a889-531f-4880-a1a4-5dda5289e5ff',
        '148f420f-f7db-4145-80f4-3d3fa036096b',
        '15b2d6f6-228d-4248-84be-1f8f45e204fc',
        '2bd013f9-48ad-43d3-a6eb-7fc3c130cf87',
        '39217bcc-8fd1-4825-afca-e97598a13f0a',
        '39ab6f28-c166-47cf-91a7-f0b864ded4ff',
        '476e2c35-07d6-40cc-bf01-6ddb22ccca44',
        '5e7d5839-04fe-4b33-93c7-a382521a74b8',
        '651460f1-5fce-4443-bc9d-4dd4b6ae8a8b',
        '69e284dd-e253-484a-8aad-676026eebf0e',
        '6f2c8d94-1a7b-4e53-8d90-3c5e7b1a4f28',
        '771b25f4-168b-443c-8e9d-b6a1c1673b91',
        '78acc234-87bc-4e8f-986f-4857369b41f8',
        '78bfeead-a38d-424a-81b9-7cd553b92bcc',
        '8d1b6a2f-4c3e-4f0a-9c2b-6f1d2e7a5b94',
        '9c4e7a52-6b18-4d3f-8e21-5a7c0d9f2b64',
        '9cd96c38-95a1-4bd4-bfaa-0e20c4acb1b9',
        '9f8eaf39-8d16-47ef-9ef6-f22b1c9a5421',
        'a399ff74-5716-4411-bca8-c5ab87ec2e7d',
        'a3b7065b-47ef-4c92-93d1-59300f8b059c',
        'a5610880-05be-426b-a82b-7f3b645bf255',
        'a7c95d9b-3fc2-4e6c-bebb-7a62fa912d84',
        'addfad00-1b11-4674-83fa-913667f87e79',
        'b00f7a0f-9094-4186-b8c4-066b1df6c395',
        'b1a7c2e4-5d3f-4a91-8c26-0e7f4b9a1d33',
        'c4d9e1f2-7a68-4c05-9b3d-5f2a8e6c0b47',
        'c6fb63eb-fdf4-4fdf-954d-7610aad7be1b',
        'c8645b41-48b5-489c-bd2e-02283535a7c5',
        'd1125b70-e83b-4fc6-bf60-7a6e36f5f56a',
        'd5ecf8af-a6c4-4f0a-93e1-2c6d0a56a726',
        'e2569df0-2f10-4b20-b41d-177b66cd136c',
        'e2f4a1b7-3c58-4d09-9e62-1a7b5c8d0f24',
        'e9418c36-3234-4806-a05a-0f259482238d',
        'f40dc797-ac89-4687-8aa2-157c639be233'
      ]::uuid[])
  );
$function$;

alter function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  owner to vortex_owner;

revoke all on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint)
  to postgres;

comment on function vortex_definition.application_release_contains_custom_components_internal(uuid, bigint) is
  'Private: true when the stored dependency manifest of an Application release names a platform block that is not a built-in block, that is, a custom component.';
