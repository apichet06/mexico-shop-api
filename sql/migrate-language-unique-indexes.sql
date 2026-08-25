-- Translated labels may legitimately be identical in different languages.
-- Keep names unique inside each language instead of across the whole table.
ALTER TABLE CategoryLangs
    DROP INDEX cl_name_UNIQUE,
    ADD UNIQUE KEY uq_category_lang_name (lg_code, cl_name);

ALTER TABLE ProductTagLangs
    DROP INDEX ptag_name_UNIQUE,
    ADD UNIQUE KEY uq_product_tag_lang_name (lg_code, ptag_name);
