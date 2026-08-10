const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pos',
  port: parseInt(process.env.DB_PORT || '3306', 10),
};

async function check() {
  const conn = await mysql.createConnection(dbConfig);
  try {
    const [restaurants] = await conn.query('SELECT * FROM restaurants');
    console.log('RESTAURANTS:');
    console.table(restaurants);

    const [admins] = await conn.query('SELECT * FROM _admins_base');
    console.log('ADMINS BASE:');
    console.table(admins);

    const [staff] = await conn.query('SELECT * FROM _pos_staff_base');
    console.log('POS STAFF BASE:');
    console.table(staff);

  } catch (err) {
    console.error(err);
  } finally {
    await conn.end();
  }
}

check();
