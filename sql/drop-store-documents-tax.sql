-- Mexico Shop: remove seller documents and tax/identity data.
-- Run during a maintenance window after taking a database backup.
DROP TABLE IF EXISTS Store_Documents;

DROP TABLE IF EXISTS Store_Tax_Profile;