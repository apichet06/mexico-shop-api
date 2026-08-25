-- แก้ข้อมูลเดิมเฉพาะสินค้าที่ต้นฉบับสเปนเป็น prueba
-- เงื่อนไข join ด้วย p_id ป้องกันไม่ให้คำว่า test ของสินค้าอื่นถูกเปลี่ยน
UPDATE ProductLangs AS thai
INNER JOIN ProductLangs AS spanish
    ON spanish.p_id = thai.p_id
    AND spanish.lg_code = 'es'
SET thai.p_name = 'ทดสอบ'
WHERE thai.lg_code = 'th'
  AND LOWER(thai.p_name) = 'test'
  AND LOWER(spanish.p_name) = 'prueba';
