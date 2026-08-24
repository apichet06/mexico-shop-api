import mysql from 'mysql2/promise';
import { env } from "../config/env.js";


export const pool = mysql.createPool({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    port: env.DB_PORT,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    // กัน connection “เน่า” + network idle kill
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,

    // กันค้างยาว
    connectTimeout: 10_000,
});
