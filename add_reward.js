const { Pool } = require('pg');

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'honforge',
    user: process.env.DB_USER || 'honforge',
    password: process.env.DB_PASSWORD || 'honforge',
};

const pool = new Pool(config);

async function addReward() {
    try {
        const query = `
            INSERT INTO rewards (name, description, reward_type, target_id, cost, stock, image_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        const values = [
            'HoN Open ACD',
            'Modify Heroes of Newerth gameplay (Control player camera distance).',
            'mod',
            'HoNOpenACD',
            2222,
            -1,
            'points card/icon.png'
        ];
        
        await pool.query(query, values);
        console.log('Reward added successfully!');
    } catch (e) {
        console.error('Error adding reward:', e);
    } finally {
        pool.end();
    }
}

addReward();
