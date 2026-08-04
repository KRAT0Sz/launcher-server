const { Pool } = require('pg');
const fs = require('fs');

const envFile = fs.readFileSync('.env', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
        env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
});

const config = {
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT || '5432', 10),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
};

const pool = new Pool(config);

async function run() {
    try {
        const queryText = `UPDATE rewards SET description = 'ปรับแต่งตัวเกม Heroes of Newerth (ปลดล็อกมุมกล้อง)' WHERE target_id = 'HoNOpenACD'`;
        await pool.query(queryText);
        console.log('Reward description updated to Thai successfully!');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        pool.end();
    }
}
run();
