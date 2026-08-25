-- Mexico-only address cleanup.
-- Foreign keys are removed dynamically by scripts/drop-thai-address-tables.mjs
-- because their names can differ between database environments.
DROP TABLE IF EXISTS `Subdistricts`;
DROP TABLE IF EXISTS `Districts`;
DROP TABLE IF EXISTS `Provinces`;
