-- เพิ่มชื่อผู้ใช้สำหรับบัญชีพนักงานภายในองค์กร
-- บัญชีเดิมคงค่า NULL จนกว่าผู้ดูแลจะกำหนดจากหน้า My Shop

SET @has_employee_username := (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'Employees'
      AND column_name = 'e_usercode'
);

SET @add_employee_username_sql := IF(
    @has_employee_username = 0,
    'ALTER TABLE Employees ADD COLUMN e_usercode VARCHAR(30) NULL AFTER e_id',
    'SELECT 1'
);
PREPARE add_employee_username_stmt FROM @add_employee_username_sql;
EXECUTE add_employee_username_stmt;
DEALLOCATE PREPARE add_employee_username_stmt;

SET @has_employee_username_index := (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'Employees'
      AND index_name = 'uq_employees_usercode'
);

SET @add_employee_username_index_sql := IF(
    @has_employee_username_index = 0,
    'ALTER TABLE Employees ADD UNIQUE KEY uq_employees_usercode (e_usercode)',
    'SELECT 1'
);
PREPARE add_employee_username_index_stmt FROM @add_employee_username_index_sql;
EXECUTE add_employee_username_index_stmt;
DEALLOCATE PREPARE add_employee_username_index_stmt;
