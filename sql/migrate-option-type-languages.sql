-- Keep OptionTypes.otype_name as the Spanish compatibility value while
-- localized storefront labels live in this language table.
CREATE TABLE IF NOT EXISTS OptionTypeLangs (
    otl_id INT NOT NULL AUTO_INCREMENT,
    otype_id INT NOT NULL,
    lg_code VARCHAR(5) NOT NULL,
    otl_name VARCHAR(45) NOT NULL,
    PRIMARY KEY (otl_id),
    UNIQUE KEY uq_option_type_language (otype_id, lg_code),
    CONSTRAINT fk_option_type_lang_type
        FOREIGN KEY (otype_id) REFERENCES OptionTypes (otype_id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- Seed the current master values in all four languages. Unknown future codes
-- safely fall back to the existing name; CRUD will translate new values.
INSERT IGNORE INTO OptionTypeLangs (otype_id, lg_code, otl_name)
SELECT otype_id, 'es', CASE otype_code
    WHEN 'COLOR' THEN 'Color'
    WHEN 'SIZE' THEN 'Tamaño'
    WHEN 'MATERIAL' THEN 'Material'
    WHEN 'FLAVOR' THEN 'Sabor'
    WHEN 'PACKAGE' THEN 'Paquete'
    WHEN 'STYLE' THEN 'Estilo'
    WHEN 'MODEL' THEN 'Modelo'
    WHEN 'FORMULA' THEN 'Fórmula'
    WHEN 'PACK_QTY' THEN 'Cantidad por paquete'
    WHEN 'DIAMETER' THEN 'Diámetro'
    WHEN 'LENGTH' THEN 'Longitud'
    WHEN 'COATING' THEN 'Recubrimiento'
    WHEN 'GRADE' THEN 'Grado'
    WHEN 'COMPATIBILITY' THEN 'Compatibilidad'
    ELSE COALESCE(otype_name, otype_code)
END FROM OptionTypes;

INSERT IGNORE INTO OptionTypeLangs (otype_id, lg_code, otl_name)
SELECT otype_id, 'en', CASE otype_code
    WHEN 'COLOR' THEN 'Color'
    WHEN 'SIZE' THEN 'Size'
    WHEN 'MATERIAL' THEN 'Material'
    WHEN 'FLAVOR' THEN 'Flavor'
    WHEN 'PACKAGE' THEN 'Package'
    WHEN 'STYLE' THEN 'Style'
    WHEN 'MODEL' THEN 'Model'
    WHEN 'FORMULA' THEN 'Formula'
    WHEN 'PACK_QTY' THEN 'Pack quantity'
    WHEN 'DIAMETER' THEN 'Diameter'
    WHEN 'LENGTH' THEN 'Length'
    WHEN 'COATING' THEN 'Coating'
    WHEN 'GRADE' THEN 'Grade'
    WHEN 'COMPATIBILITY' THEN 'Compatibility'
    ELSE COALESCE(otype_name, otype_code)
END FROM OptionTypes;

INSERT IGNORE INTO OptionTypeLangs (otype_id, lg_code, otl_name)
SELECT otype_id, 'ja', CASE otype_code
    WHEN 'COLOR' THEN 'カラー'
    WHEN 'SIZE' THEN 'サイズ'
    WHEN 'MATERIAL' THEN '素材'
    WHEN 'FLAVOR' THEN 'フレーバー'
    WHEN 'PACKAGE' THEN 'パッケージ'
    WHEN 'STYLE' THEN 'スタイル'
    WHEN 'MODEL' THEN 'モデル'
    WHEN 'FORMULA' THEN '処方'
    WHEN 'PACK_QTY' THEN '入数'
    WHEN 'DIAMETER' THEN '直径'
    WHEN 'LENGTH' THEN '長さ'
    WHEN 'COATING' THEN 'コーティング'
    WHEN 'GRADE' THEN 'グレード'
    WHEN 'COMPATIBILITY' THEN '互換性'
    ELSE COALESCE(otype_name, otype_code)
END FROM OptionTypes;

INSERT IGNORE INTO OptionTypeLangs (otype_id, lg_code, otl_name)
SELECT otype_id, 'th', CASE otype_code
    WHEN 'COLOR' THEN 'สี'
    WHEN 'SIZE' THEN 'ขนาด'
    WHEN 'MATERIAL' THEN 'วัสดุ'
    WHEN 'FLAVOR' THEN 'รสชาติ'
    WHEN 'PACKAGE' THEN 'แพ็กเกจ'
    WHEN 'STYLE' THEN 'รูปแบบ'
    WHEN 'MODEL' THEN 'รุ่น'
    WHEN 'FORMULA' THEN 'สูตร'
    WHEN 'PACK_QTY' THEN 'จำนวนต่อแพ็ก'
    WHEN 'DIAMETER' THEN 'เส้นผ่านศูนย์กลาง'
    WHEN 'LENGTH' THEN 'ความยาว'
    WHEN 'COATING' THEN 'การเคลือบ'
    WHEN 'GRADE' THEN 'เกรดสินค้า'
    WHEN 'COMPATIBILITY' THEN 'รุ่นที่รองรับ'
    ELSE COALESCE(otype_name, otype_code)
END FROM OptionTypes;
