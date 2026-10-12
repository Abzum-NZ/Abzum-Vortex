-- Rows installed by migrations, excluding tenant and demo data.

-- vortex_access.validation_reference_values: 208 rows
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'amount', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'billing', 2);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'charge', 3);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'chargeable', 4);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'cost', 5);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'credential', 6);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'currency', 7);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'customer', 8);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'invoice', 9);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'password', 10);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'payment', 11);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'plan', 12);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'price', 13);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'pricing', 14);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'secret', 15);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'subscription', 16);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_topic_prefix', 'vortex:invalidation', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'created', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'changed', 2);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'deleted', 3);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'restored', 4);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'access_changed', 5);
-- BEGIN GENERATED: organization settings reference seed
insert into vortex_access.validation_reference_values (
  reference_list, reference_value, reference_ordinal
) values
  ('organization_runtime_settings_currency', 'AED', 1),
  ('organization_runtime_settings_currency', 'AFN', 2),
  ('organization_runtime_settings_currency', 'ALL', 3),
  ('organization_runtime_settings_currency', 'AMD', 4),
  ('organization_runtime_settings_currency', 'AOA', 5),
  ('organization_runtime_settings_currency', 'ARS', 6),
  ('organization_runtime_settings_currency', 'AUD', 7),
  ('organization_runtime_settings_currency', 'AWG', 8),
  ('organization_runtime_settings_currency', 'AZN', 9),
  ('organization_runtime_settings_currency', 'BAM', 10),
  ('organization_runtime_settings_currency', 'BBD', 11),
  ('organization_runtime_settings_currency', 'BDT', 12),
  ('organization_runtime_settings_currency', 'BHD', 13),
  ('organization_runtime_settings_currency', 'BIF', 14),
  ('organization_runtime_settings_currency', 'BMD', 15),
  ('organization_runtime_settings_currency', 'BND', 16),
  ('organization_runtime_settings_currency', 'BOB', 17),
  ('organization_runtime_settings_currency', 'BOV', 18),
  ('organization_runtime_settings_currency', 'BRL', 19),
  ('organization_runtime_settings_currency', 'BSD', 20),
  ('organization_runtime_settings_currency', 'BTN', 21),
  ('organization_runtime_settings_currency', 'BWP', 22),
  ('organization_runtime_settings_currency', 'BYN', 23),
  ('organization_runtime_settings_currency', 'BZD', 24),
  ('organization_runtime_settings_currency', 'CAD', 25),
  ('organization_runtime_settings_currency', 'CDF', 26),
  ('organization_runtime_settings_currency', 'CHE', 27),
  ('organization_runtime_settings_currency', 'CHF', 28),
  ('organization_runtime_settings_currency', 'CHW', 29),
  ('organization_runtime_settings_currency', 'CLF', 30),
  ('organization_runtime_settings_currency', 'CLP', 31),
  ('organization_runtime_settings_currency', 'CNY', 32),
  ('organization_runtime_settings_currency', 'COP', 33),
  ('organization_runtime_settings_currency', 'COU', 34),
  ('organization_runtime_settings_currency', 'CRC', 35),
  ('organization_runtime_settings_currency', 'CUP', 36),
  ('organization_runtime_settings_currency', 'CVE', 37),
  ('organization_runtime_settings_currency', 'CZK', 38),
  ('organization_runtime_settings_currency', 'DJF', 39),
  ('organization_runtime_settings_currency', 'DKK', 40),
  ('organization_runtime_settings_currency', 'DOP', 41),
  ('organization_runtime_settings_currency', 'DZD', 42),
  ('organization_runtime_settings_currency', 'EGP', 43),
  ('organization_runtime_settings_currency', 'ERN', 44),
  ('organization_runtime_settings_currency', 'ETB', 45),
  ('organization_runtime_settings_currency', 'EUR', 46),
  ('organization_runtime_settings_currency', 'FJD', 47),
  ('organization_runtime_settings_currency', 'FKP', 48),
  ('organization_runtime_settings_currency', 'GBP', 49),
  ('organization_runtime_settings_currency', 'GEL', 50),
  ('organization_runtime_settings_currency', 'GHS', 51),
  ('organization_runtime_settings_currency', 'GIP', 52),
  ('organization_runtime_settings_currency', 'GMD', 53),
  ('organization_runtime_settings_currency', 'GNF', 54),
  ('organization_runtime_settings_currency', 'GTQ', 55),
  ('organization_runtime_settings_currency', 'GYD', 56),
  ('organization_runtime_settings_currency', 'HKD', 57),
  ('organization_runtime_settings_currency', 'HNL', 58),
  ('organization_runtime_settings_currency', 'HTG', 59),
  ('organization_runtime_settings_currency', 'HUF', 60),
  ('organization_runtime_settings_currency', 'IDR', 61),
  ('organization_runtime_settings_currency', 'ILS', 62),
  ('organization_runtime_settings_currency', 'INR', 63),
  ('organization_runtime_settings_currency', 'IQD', 64),
  ('organization_runtime_settings_currency', 'IRR', 65),
  ('organization_runtime_settings_currency', 'ISK', 66),
  ('organization_runtime_settings_currency', 'JMD', 67),
  ('organization_runtime_settings_currency', 'JOD', 68),
  ('organization_runtime_settings_currency', 'JPY', 69),
  ('organization_runtime_settings_currency', 'KES', 70),
  ('organization_runtime_settings_currency', 'KGS', 71),
  ('organization_runtime_settings_currency', 'KHR', 72),
  ('organization_runtime_settings_currency', 'KMF', 73),
  ('organization_runtime_settings_currency', 'KPW', 74),
  ('organization_runtime_settings_currency', 'KRW', 75),
  ('organization_runtime_settings_currency', 'KWD', 76),
  ('organization_runtime_settings_currency', 'KYD', 77),
  ('organization_runtime_settings_currency', 'KZT', 78),
  ('organization_runtime_settings_currency', 'LAK', 79),
  ('organization_runtime_settings_currency', 'LBP', 80),
  ('organization_runtime_settings_currency', 'LKR', 81),
  ('organization_runtime_settings_currency', 'LRD', 82),
  ('organization_runtime_settings_currency', 'LSL', 83),
  ('organization_runtime_settings_currency', 'LYD', 84),
  ('organization_runtime_settings_currency', 'MAD', 85),
  ('organization_runtime_settings_currency', 'MDL', 86),
  ('organization_runtime_settings_currency', 'MGA', 87),
  ('organization_runtime_settings_currency', 'MKD', 88),
  ('organization_runtime_settings_currency', 'MMK', 89),
  ('organization_runtime_settings_currency', 'MNT', 90),
  ('organization_runtime_settings_currency', 'MOP', 91),
  ('organization_runtime_settings_currency', 'MRU', 92),
  ('organization_runtime_settings_currency', 'MUR', 93),
  ('organization_runtime_settings_currency', 'MVR', 94),
  ('organization_runtime_settings_currency', 'MWK', 95),
  ('organization_runtime_settings_currency', 'MXN', 96),
  ('organization_runtime_settings_currency', 'MXV', 97),
  ('organization_runtime_settings_currency', 'MYR', 98),
  ('organization_runtime_settings_currency', 'MZN', 99),
  ('organization_runtime_settings_currency', 'NAD', 100),
  ('organization_runtime_settings_currency', 'NGN', 101),
  ('organization_runtime_settings_currency', 'NIO', 102),
  ('organization_runtime_settings_currency', 'NOK', 103),
  ('organization_runtime_settings_currency', 'NPR', 104),
  ('organization_runtime_settings_currency', 'NZD', 105),
  ('organization_runtime_settings_currency', 'OMR', 106),
  ('organization_runtime_settings_currency', 'PAB', 107),
  ('organization_runtime_settings_currency', 'PEN', 108),
  ('organization_runtime_settings_currency', 'PGK', 109),
  ('organization_runtime_settings_currency', 'PHP', 110),
  ('organization_runtime_settings_currency', 'PKR', 111),
  ('organization_runtime_settings_currency', 'PLN', 112),
  ('organization_runtime_settings_currency', 'PYG', 113),
  ('organization_runtime_settings_currency', 'QAR', 114),
  ('organization_runtime_settings_currency', 'RON', 115),
  ('organization_runtime_settings_currency', 'RSD', 116),
  ('organization_runtime_settings_currency', 'RUB', 117),
  ('organization_runtime_settings_currency', 'RWF', 118),
  ('organization_runtime_settings_currency', 'SAR', 119),
  ('organization_runtime_settings_currency', 'SBD', 120),
  ('organization_runtime_settings_currency', 'SCR', 121),
  ('organization_runtime_settings_currency', 'SDG', 122),
  ('organization_runtime_settings_currency', 'SEK', 123),
  ('organization_runtime_settings_currency', 'SGD', 124),
  ('organization_runtime_settings_currency', 'SHP', 125),
  ('organization_runtime_settings_currency', 'SLE', 126),
  ('organization_runtime_settings_currency', 'SOS', 127),
  ('organization_runtime_settings_currency', 'SRD', 128),
  ('organization_runtime_settings_currency', 'SSP', 129),
  ('organization_runtime_settings_currency', 'STN', 130),
  ('organization_runtime_settings_currency', 'SVC', 131),
  ('organization_runtime_settings_currency', 'SYP', 132),
  ('organization_runtime_settings_currency', 'SZL', 133),
  ('organization_runtime_settings_currency', 'THB', 134),
  ('organization_runtime_settings_currency', 'TJS', 135),
  ('organization_runtime_settings_currency', 'TMT', 136),
  ('organization_runtime_settings_currency', 'TND', 137),
  ('organization_runtime_settings_currency', 'TOP', 138),
  ('organization_runtime_settings_currency', 'TRY', 139),
  ('organization_runtime_settings_currency', 'TTD', 140),
  ('organization_runtime_settings_currency', 'TWD', 141),
  ('organization_runtime_settings_currency', 'TZS', 142),
  ('organization_runtime_settings_currency', 'UAH', 143),
  ('organization_runtime_settings_currency', 'UGX', 144),
  ('organization_runtime_settings_currency', 'USD', 145),
  ('organization_runtime_settings_currency', 'USN', 146),
  ('organization_runtime_settings_currency', 'UYI', 147),
  ('organization_runtime_settings_currency', 'UYU', 148),
  ('organization_runtime_settings_currency', 'UYW', 149),
  ('organization_runtime_settings_currency', 'UZS', 150),
  ('organization_runtime_settings_currency', 'VED', 151),
  ('organization_runtime_settings_currency', 'VES', 152),
  ('organization_runtime_settings_currency', 'VND', 153),
  ('organization_runtime_settings_currency', 'VUV', 154),
  ('organization_runtime_settings_currency', 'WST', 155),
  ('organization_runtime_settings_currency', 'XAD', 156),
  ('organization_runtime_settings_currency', 'XAF', 157),
  ('organization_runtime_settings_currency', 'XAG', 158),
  ('organization_runtime_settings_currency', 'XAU', 159),
  ('organization_runtime_settings_currency', 'XBA', 160),
  ('organization_runtime_settings_currency', 'XBB', 161),
  ('organization_runtime_settings_currency', 'XBC', 162),
  ('organization_runtime_settings_currency', 'XBD', 163),
  ('organization_runtime_settings_currency', 'XCD', 164),
  ('organization_runtime_settings_currency', 'XCG', 165),
  ('organization_runtime_settings_currency', 'XDR', 166),
  ('organization_runtime_settings_currency', 'XOF', 167),
  ('organization_runtime_settings_currency', 'XPD', 168),
  ('organization_runtime_settings_currency', 'XPF', 169),
  ('organization_runtime_settings_currency', 'XPT', 170),
  ('organization_runtime_settings_currency', 'XSU', 171),
  ('organization_runtime_settings_currency', 'XTS', 172),
  ('organization_runtime_settings_currency', 'XUA', 173),
  ('organization_runtime_settings_currency', 'XXX', 174),
  ('organization_runtime_settings_currency', 'YER', 175),
  ('organization_runtime_settings_currency', 'ZAR', 176),
  ('organization_runtime_settings_currency', 'ZMW', 177),
  ('organization_runtime_settings_currency', 'ZWG', 178),
  ('organization_runtime_settings_date_format', 'short', 1),
  ('organization_runtime_settings_date_format', 'medium', 2),
  ('organization_runtime_settings_date_format', 'long', 3),
  ('organization_runtime_settings_date_format', 'full', 4),
  ('organization_runtime_settings_number_format', 'auto', 1),
  ('organization_runtime_settings_number_format', 'always', 2),
  ('organization_runtime_settings_number_format', 'min2', 3),
  ('organization_runtime_settings_number_format', 'never', 4)
;
-- END GENERATED: organization settings reference seed

-- vortex_access.platform_permission_declarations: 22 rows
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '687d5649-62ee-43dd-b684-b8af3a5394c1', 'platform.organization.permissions.read', 'read', 'View available permissions', 'View the selected organisation''s registered permission catalogue without receiving use or assignment authority.', 'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2', 'platform.organization.roles.read', 'read', 'View roles', 'View the selected organisation''s live roles and registered application role templates.', 'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '87c96495-c806-4692-9bc2-250ddb10613c', 'platform.organization.roles.manage', 'manage', 'Manage roles', 'Create, change or retire roles only within the actor''s explicit delegated scope.', 'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '290ae49f-4cab-4159-9c20-6e664f07d50b', 'platform.organization.groups.read', 'read', 'View groups', 'View the selected organisation''s Groups and membership administration data.', 'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '6185dc64-464b-4776-97dc-c64a6f299550', 'platform.organization.groups.manage', 'manage', 'Manage groups', 'Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.', 'sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '9901c0dc-8bac-45c7-be0b-3642cb839bb1', 'platform.organization.assignments.read', 'read', 'View access assignments', 'View the selected organisation''s role and delegation assignments and their effective scope.', 'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df', 'platform.organization.assignments.manage', 'manage', 'Manage access assignments', 'Grant, change or revoke use and delegation assignments only within the actor''s explicit delegated scope.', 'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '02c772e5-2921-4300-ad90-4f5772a7fa46', 'platform.organization.accounts.read', 'read', 'View organisation accounts', 'View the selected organisation''s safe account-administration information.', 'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '630a980c-0ff5-40b1-a329-7326a2122395', 'platform.organization.accounts.manage', 'manage', 'Manage organisation accounts', 'Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.', 'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '9300e501-6d56-41b1-b203-3361dbace9bc', 'platform.organization.invitations.read', 'read', 'View invitations', 'View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.', 'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb', 'platform.organization.invitations.manage', 'manage', 'Manage invitations', 'Create or revoke invitations through the protected operation; role assignment additionally requires the actor''s assignment authority.', 'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5', 'platform.organization.runtime_settings.read', 'read', 'View organisation display settings', 'View the organisation''s default language, time zone, currency, date and number display settings.', 'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'c658c254-2884-414a-9012-512c0cfe4b34', 'platform.organization.runtime_settings.manage', 'manage', 'Manage organisation display settings', 'Change the organisation''s validated default display settings through the protected revision-checked operation.', 'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '7ecd3304-f16c-47d4-94db-0964980091ba', 'platform.organization.applications.manage', 'manage', 'Manage applications', 'Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.', 'sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81', 'organisation-administration', false, 3);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d', 'platform.organization.connections.manage', 'manage', 'Manage connections', 'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.', 'sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e', 'system-core', false, 4);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847', 'platform.security.identities.disable', 'manage', 'Disable identities', 'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.', 'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '014d2898-1969-4434-805c-eeb0f0e6f797', 'platform.support.access.request', 'manage', 'Request support access', 'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.', 'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '07e4653c-d358-489f-8067-46e085d99478', 'platform.organization.support.approve', 'manage', 'Approve support access', 'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.', 'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '0548c061-b1a9-48e5-a04a-eb1d0dae0644', 'platform.organization.definition_drafts.manage', 'manage', 'Manage definition drafts', 'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.', 'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'dfdd5aba-2b85-4169-b570-92be284e7b5c', 'platform.organization.definition_releases.manage', 'manage', 'Manage definition releases', 'Publish module and application drafts as immutable releases without receiving installation or business-record authority.', 'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'd1be247f-094d-47c1-a38d-762290868c91', 'platform.organization.custom_code.manage', 'manage', 'Manage custom code', 'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.', 'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'eaade6fd-7390-44d2-a7ef-343324c7384a', 'platform.organization.system_applications.manage', 'manage', 'Manage system applications', 'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.', 'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b', 'system-core', false, 6);

-- vortex_record.protected_read_model_views: 16 rows
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_runtime_settings', 'vortex_access', 'list_organization_runtime_settings_projection', '2026-10-12 16:24:38.327221+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_accounts', 'vortex_access', 'list_organization_accounts_projection', '2026-10-12 16:24:39.837915+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_invitations', 'vortex_access', 'list_organization_invitations_projection', '2026-10-12 16:24:39.837915+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('groups', 'vortex_access', 'list_organization_groups_projection', '2026-10-12 16:24:39.908127+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('people', 'vortex_access', 'list_organization_group_memberships_projection', '2026-10-12 16:24:39.908127+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('permissions', 'vortex_access', 'list_organization_permissions_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('roles', 'vortex_access', 'list_organization_roles_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('effective_assignments', 'vortex_access', 'list_organization_role_assignments_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('role_activations', 'vortex_access', 'list_organization_role_activations_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('delegations', 'vortex_access', 'list_organization_delegations_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenant_structure', 'vortex_identity', 'list_organizations_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenants', 'vortex_identity', 'list_tenants_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenant_administrators', 'vortex_identity', 'list_tenant_administrators_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('installed_applications', 'vortex_access', 'list_installed_applications_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('landing_zone_applications', 'vortex_access', 'list_landing_zone_applications_projection', '2026-10-12 16:24:42.94796+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('application_role_templates', 'vortex_access', 'list_application_role_templates_projection', '2026-10-12 16:24:50.984155+00');

INSERT INTO storage.buckets (id, name, public) VALUES ('private_files', 'private_files', false), ('component_bundles', 'component_bundles', false) ON CONFLICT (id) DO UPDATE SET public = false;

CREATE POLICY vortex_component_bundle_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_component_bundle_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_delete ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'delete'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
