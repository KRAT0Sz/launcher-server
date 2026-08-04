const { Pool } = require('pg');

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'honforge',
    user: process.env.DB_USER || 'honforge',
    password: process.env.DB_PASSWORD || 'honforge',
};

const pool = new Pool(config);

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                discord_id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                avatar_url TEXT,
                points INT DEFAULT 0,
                role VARCHAR(50) DEFAULT 'user',
                created_at BIGINT
            );

            CREATE TABLE IF NOT EXISTS point_logs (
                log_id SERIAL PRIMARY KEY,
                discord_id VARCHAR(255) REFERENCES users(discord_id),
                points_change INT NOT NULL,
                reason TEXT NOT NULL,
                created_at BIGINT
            );

            CREATE TABLE IF NOT EXISTS rewards (
                reward_id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                reward_type VARCHAR(50) NOT NULL, -- 'mod' or 'item_code'
                target_id VARCHAR(255), -- Mod ID if it's a mod
                cost INT NOT NULL,
                stock INT DEFAULT -1, -- -1 for unlimited
                image_url TEXT
            );

            CREATE TABLE IF NOT EXISTS redemptions (
                redemption_id SERIAL PRIMARY KEY,
                discord_id VARCHAR(255) REFERENCES users(discord_id),
                reward_id INT REFERENCES rewards(reward_id),
                status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed'
                item_code TEXT, -- If applicable
                created_at BIGINT
            );
            
            CREATE TABLE IF NOT EXISTS mod_unlocks (
                discord_id VARCHAR(255) REFERENCES users(discord_id),
                mod_id VARCHAR(255) NOT NULL,
                unlocked_at BIGINT,
                PRIMARY KEY (discord_id, mod_id)
            );
        `);
        console.log("Database tables created successfully.");
    } catch (e) {
        console.error("Failed to create tables:", e);
    } finally {
        await pool.end();
    }
}

initDb();
