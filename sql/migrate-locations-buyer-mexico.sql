-- Phase 1: support Mexico buyer addresses without deleting legacy data.
-- Legacy Thailand foreign-key columns become nullable until every dependent
-- buyer/store/order flow has migrated. They will be removed in the final cleanup.

ALTER TABLE Locations_buyer
    MODIFY COLUMN provinces_id INT NULL,
    MODIFY COLUMN districts_id INT NULL,
    MODIFY COLUMN subdistricts_id INT NULL,
    ADD COLUMN country_code CHAR(2) NULL AFTER locb_phone,
    ADD COLUMN state VARCHAR(100) NULL AFTER country_code,
    ADD COLUMN city VARCHAR(120) NULL AFTER state,
    ADD COLUMN municipality VARCHAR(120) NULL AFTER city,
    ADD COLUMN colonia VARCHAR(160) NULL AFTER municipality,
    ADD COLUMN latitude DECIMAL(10, 7) NULL AFTER zip_code,
    ADD COLUMN longitude DECIMAL(10, 7) NULL AFTER latitude,
    ADD COLUMN formatted_address VARCHAR(500) NULL AFTER longitude;

CREATE INDEX idx_locations_buyer_mexico_postal
    ON Locations_buyer (country_code, zip_code);
