-- รองรับคลังสินค้า/สาขาในประเทศเม็กซิโก โดยยังเก็บข้อมูลที่อยู่แบบเดิมไว้
-- ระหว่างช่วงเปลี่ยนผ่าน legacy foreign keys ต้อง nullable เพื่อให้สร้างที่อยู่เม็กซิโกได้

ALTER TABLE Locations
    MODIFY COLUMN Provinces_id INT NULL,
    MODIFY COLUMN Districts_id INT NULL,
    MODIFY COLUMN Subdistricts_id INT NULL,
    ADD COLUMN country_code CHAR(2) NULL AFTER st_id,
    ADD COLUMN colonia VARCHAR(160) NULL AFTER loc_address,
    ADD COLUMN municipality VARCHAR(120) NULL AFTER colonia,
    ADD COLUMN city VARCHAR(120) NULL AFTER municipality,
    ADD COLUMN state VARCHAR(100) NULL AFTER city,
    ADD COLUMN latitude DECIMAL(10, 7) NULL AFTER zip_code,
    ADD COLUMN longitude DECIMAL(10, 7) NULL AFTER latitude,
    ADD COLUMN formatted_address VARCHAR(500) NULL AFTER longitude;

CREATE INDEX idx_locations_mexico_postal ON Locations (country_code, zip_code);
