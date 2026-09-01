-- Run after backing up and clearing test orders.
-- provider_code is the only carrier identifier used by the application.
UPDATE Shipping_carriers
SET provider_code = LOWER(TRIM(provider_code))
WHERE provider_code IS NOT NULL;

DELETE FROM Shipping_carriers
WHERE provider_code IS NULL OR TRIM(provider_code) = '';

ALTER TABLE Shipping_carriers
  MODIFY provider_code VARCHAR(80) NOT NULL,
  DROP COLUMN shippop_courier_code;

ALTER TABLE Orders
  DROP COLUMN shipping_zone_code;

DROP TABLE IF EXISTS Shipping_rates;
DROP TABLE IF EXISTS Postcode_zone_rules;
