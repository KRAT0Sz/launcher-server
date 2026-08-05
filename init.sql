CREATE TABLE IF NOT EXISTS mod_downloads (
    mod_id VARCHAR(255) PRIMARY KEY,
    count INT NOT NULL DEFAULT 0,
    last_updated BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    socket_id VARCHAR(255),
    nickname VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_vip SMALLINT DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS vip_users (
    name VARCHAR(255) PRIMARY KEY,
    created_at BIGINT NOT NULL
);

-- Rewards System Tables
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

INSERT INTO rewards (name, description, reward_type, target_id, cost, stock, image_url)
VALUES ('HoN Open ACD', 'Modify Heroes of Newerth gameplay (Control player camera distance)', 'mod', 'HoNOpenACD', 2222, -1, 'points card/icon.png')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS redemptions (
    redemption_id SERIAL PRIMARY KEY,
    discord_id VARCHAR(255) REFERENCES users(discord_id),
    reward_id INT REFERENCES rewards(reward_id),
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed'
    item_code TEXT, -- If applicable
    created_at BIGINT
);

-- Community Board Posts Table
CREATE TABLE IF NOT EXISTS community_posts (
    post_id SERIAL PRIMARY KEY,
    discord_id VARCHAR(255) REFERENCES users(discord_id),
    username VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    content TEXT NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    created_at BIGINT NOT NULL
);

ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';

CREATE TABLE IF NOT EXISTS promo_codes (
    code VARCHAR(50) PRIMARY KEY,
    points INT NOT NULL,
    max_uses INT DEFAULT -1, -- -1 for unlimited
    current_uses INT DEFAULT 0,
    expires_at BIGINT, -- NULL for no expiration
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) REFERENCES promo_codes(code),
    discord_id VARCHAR(255) REFERENCES users(discord_id),
    created_at BIGINT NOT NULL,
    UNIQUE(code, discord_id)
);

CREATE TABLE IF NOT EXISTS mod_unlocks (
    discord_id VARCHAR(255) REFERENCES users(discord_id),
    mod_id VARCHAR(255) NOT NULL,
    unlocked_at BIGINT,
    PRIMARY KEY (discord_id, mod_id)
);
