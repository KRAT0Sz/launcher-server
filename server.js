const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// =====================================================
// Environment configuration
// =====================================================
const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    db: process.env.DATABASE_URL ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    } : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'honforge',
        user: process.env.DB_USER || 'honforge',
        password: process.env.DB_PASSWORD || 'honforge',
    },
    adminToken: process.env.ADMIN_TOKEN || '',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(','),
    githubToken: process.env.GITHUB_TOKEN || '',
    cacheTtlMs: parseInt(process.env.GITHUB_CACHE_MS || String(5 * 60 * 1000), 10),
    maxChatHistory: parseInt(process.env.MAX_CHAT_HISTORY || '50', 10),
    chatRateLimitMs: parseInt(process.env.CHAT_RATE_LIMIT_MS || '1000', 10),
    discord: {
        clientId: process.env.DISCORD_CLIENT_ID || '',
        clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
        redirectUri: process.env.DISCORD_REDIRECT_URI || (process.env.NODE_ENV === 'production' ? 'https://launcher-counter.onrender.com/auth/discord/callback' : 'http://localhost:3000/auth/discord/callback'),
    },
    jwtSecret: process.env.JWT_SECRET || 'honforge-super-secret-key-change-in-prod',
};

const startedAt = Date.now();

// =====================================================
// PostgreSQL pool
// =====================================================
const pool = new Pool(config.db);

pool.on('error', (err) => {
    console.error('Unexpected error on idle PG client', err);
});

async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    if (config.nodeEnv !== 'production') {
        console.log('SQL', { text: text.substring(0, 80), ms: Date.now() - start, rows: res.rowCount });
    }
    return res;
}

// =====================================================
// Database helpers
// =====================================================
async function incrementDownload(modId) {
    const { rows } = await query(
        `INSERT INTO mod_downloads (mod_id, count, last_updated)
         VALUES ($1, 1, $2)
         ON CONFLICT (mod_id) DO UPDATE
           SET count = mod_downloads.count + 1, last_updated = EXCLUDED.last_updated
         RETURNING count`,
        [modId, Date.now()]
    );
    return rows[0].count;
}

async function getAllDownloads() {
    const { rows } = await query('SELECT mod_id, count FROM mod_downloads');
    const out = {};
    for (const row of rows) out[row.mod_id] = row.count;
    return out;
}

async function getChatHistory(limit = config.maxChatHistory) {
    const { rows } = await query(
        `SELECT nickname, message, is_vip, created_at, socket_id
         FROM chat_messages
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
    );
    return rows.reverse().map(r => ({
        nickname: r.nickname,
        message: r.message,
        timestamp: parseInt(r.created_at, 10),
        isVip: !!r.is_vip,
    }));
}

async function insertChatMessage(msg) {
    await query(
        `INSERT INTO chat_messages (socket_id, nickname, message, is_vip, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [msg.id || null, msg.nickname, msg.message, msg.isVip ? 1 : 0, msg.timestamp]
    );
}

async function getVipUser(name) {
    const { rows } = await query(
        'SELECT name, password_hash FROM vip_users WHERE LOWER(name) = LOWER($1)',
        [name]
    );
    return rows[0] || null;
}

async function listVipNames() {
    const { rows } = await query('SELECT name FROM vip_users ORDER BY name');
    return rows.map(r => r.name);
}

async function getStats() {
    const downloads = await query('SELECT COUNT(*)::int AS mods, COALESCE(SUM(count), 0)::bigint AS total FROM mod_downloads');
    const chats = await query('SELECT COUNT(*)::int AS total FROM chat_messages');
    const vips = await query('SELECT COUNT(*)::int AS total FROM vip_users');
    return {
        online: onlineCount,
        modsTracked: downloads.rows[0].mods,
        totalDownloads: parseInt(downloads.rows[0].total, 10),
        totalMessages: chats.rows[0].total,
        vipCount: vips.rows[0].total,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        startedAt,
    };
}

// =====================================================
// Express app
// =====================================================
const app = express();
app.use(helmet());
app.use(cors({ origin: config.allowedOrigins }));
app.use(express.json({ limit: '64kb' }));

// General API rate limit
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});
app.use('/downloads', apiLimiter);

// =====================================================
// Auth Middleware
// =====================================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, config.jwtSecret, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// =====================================================
// REST endpoints
// =====================================================
app.get('/', (req, res) => {
    res.json({
        name: 'HoNForge Server',
        version: require('./package.json').version,
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
});

app.get('/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({ status: 'ok', db: 'ok', uptime: Math.floor((Date.now() - startedAt) / 1000) });
    } catch (e) {
        res.status(503).json({ status: 'degraded', db: 'down', error: e.message });
    }
});

app.get('/stats', async (req, res, next) => {
    try {
        const s = await getStats();
        res.json(s);
    } catch (e) { next(e); }
});

app.get('/downloads', async (req, res, next) => {
    try {
        res.json(await getAllDownloads());
    } catch (e) { next(e); }
});

app.post('/downloads/:modId', async (req, res, next) => {
    const { modId } = req.params;
    if (!modId || modId.length > 200) {
        return res.status(400).json({ error: 'Invalid modId' });
    }
    try {
        const total = await incrementDownload(modId);
        res.json({ success: true, total });
    } catch (e) { next(e); }
});

// GitHub releases proxy with in-memory cache
let githubCache = { data: null, lastFetch: 0 };
app.get('/github-releases', async (req, res) => {
    const now = Date.now();
    if (githubCache.data && (now - githubCache.lastFetch < config.cacheTtlMs)) {
        return res.json(githubCache.data);
    }
    try {
        const headers = { 'User-Agent': 'HoNForge-Server' };
        if (config.githubToken) headers['Authorization'] = `token ${config.githubToken}`;
        const response = await fetch('https://api.github.com/repos/KRAT0Sz/hon-mod/releases', { headers });
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        const data = await response.json();
        githubCache = { data, lastFetch: now };
        res.json(data);
    } catch (e) {
        console.error('GitHub fetch error:', e.message);
        if (githubCache.data) return res.json(githubCache.data);
        res.status(500).json({ error: 'Failed to fetch from GitHub' });
    }
});

// =====================================================
// Discord OAuth2 & Membership
// =====================================================
app.get('/auth/discord', (req, res) => {
    if (!config.discord.clientId) return res.status(500).send('Discord Auth not configured');
    const url = `https://discord.com/api/oauth2/authorize?client_id=${config.discord.clientId}&redirect_uri=${encodeURIComponent(config.discord.redirectUri)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No code provided');

    try {
        // Exchange code for token
        const params = new URLSearchParams({
            client_id: config.discord.clientId,
            client_secret: config.discord.clientSecret,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: config.discord.redirectUri
        });
        
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;

        // Get user profile
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const profile = userResponse.data;
        const discordId = profile.id;
        const username = profile.username;
        const avatarUrl = profile.avatar ? `https://cdn.discordapp.com/avatars/${discordId}/${profile.avatar}.png` : null;
        
        // Upsert user to DB
        await query(`
            INSERT INTO users (discord_id, username, avatar_url, created_at) 
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (discord_id) DO UPDATE SET 
                username = EXCLUDED.username, 
                avatar_url = EXCLUDED.avatar_url
        `, [discordId, username, avatarUrl, Date.now()]);

        // Generate JWT
        const token = jwt.sign({ discord_id: discordId, username, role: 'user' }, config.jwtSecret, { expiresIn: '30d' });

        // Respond with HTML that sets the page title to the token. Electron will intercept this.
        res.send(`
            <html>
                <head>
                    <title>AUTH_TOKEN:${token}</title>
                </head>
                <body>
                    <h2>Login successful! You can close this window.</h2>
                    <script>
                        setTimeout(() => window.close(), 2000);
                    </script>
                </body>
            </html>
        `);
    } catch (e) {
        console.error('Discord Auth Error:', e.response ? e.response.data : e.message);
        res.status(500).send('Authentication failed');
    }
});

// Points & Profile API
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const { rows } = await query('SELECT discord_id, username, avatar_url, points, role FROM users WHERE discord_id = $1', [req.user.discord_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const { rows: claims } = await query(
            "SELECT reason FROM point_logs WHERE discord_id = $1 AND reason LIKE 'Claimed: %' AND created_at >= $2",
            [req.user.discord_id, startOfDay.getTime()]
        );
        
        const user = rows[0];
        user.claimsToday = claims.map(c => c.reason.replace('Claimed: ', ''));
        res.json(user);
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/points/add', async (req, res) => {
    // Basic admin check
    const token = req.headers['x-admin-token'];
    if (!config.adminToken || token !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { discord_id, amount, reason } = req.body;
    if (!discord_id || !amount || !reason) return res.status(400).json({ error: 'Missing parameters' });

    try {
        await query('UPDATE users SET points = points + $1 WHERE discord_id = $2', [amount, discord_id]);
        await query('INSERT INTO point_logs (discord_id, points_change, reason, created_at) VALUES ($1, $2, $3, $4)', [discord_id, amount, reason, Date.now()]);
        res.json({ success: true, message: `Added ${amount} points to ${discord_id}` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to add points' });
    }
});

app.get('/api/rewards', async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM rewards');
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/redeem', authenticateToken, async (req, res) => {
    const { reward_id } = req.body;
    try {
        const discord_id = req.user.discord_id;
        
        // Transaction needed for safety
        const rewardRes = await query('SELECT * FROM rewards WHERE reward_id = $1', [reward_id]);
        if (rewardRes.rows.length === 0) return res.status(404).json({ error: 'Reward not found' });
        const reward = rewardRes.rows[0];

        if (reward.stock === 0) return res.status(400).json({ error: 'Out of stock' });

        const userRes = await query('SELECT points FROM users WHERE discord_id = $1', [discord_id]);
        const points = userRes.rows[0].points;

        if (points < reward.cost) return res.status(400).json({ error: 'Not enough points' });

        // Deduct points
        await query('UPDATE users SET points = points - $1 WHERE discord_id = $2', [reward.cost, discord_id]);
        await query('INSERT INTO point_logs (discord_id, points_change, reason, created_at) VALUES ($1, $2, $3, $4)', [discord_id, -reward.cost, `Redeemed: ${reward.name}`, Date.now()]);
        
        // If it's a mod unlock
        if (reward.reward_type === 'mod') {
            await query('INSERT INTO mod_unlocks (discord_id, mod_id, unlocked_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [discord_id, reward.target_id, Date.now()]);
        }

        // Record redemption
        await query('INSERT INTO redemptions (discord_id, reward_id, created_at) VALUES ($1, $2, $3)', [discord_id, reward_id, Date.now()]);
        
        if (reward.stock > 0) {
            await query('UPDATE rewards SET stock = stock - 1 WHERE reward_id = $1', [reward_id]);
        }

        res.json({ success: true, message: 'Successfully redeemed' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Redemption failed' });
    }
});

app.get('/api/mods/unlocked', authenticateToken, async (req, res) => {
    try {
        const { rows } = await query('SELECT mod_id FROM mod_unlocks WHERE discord_id = $1', [req.user.discord_id]);
        res.json(rows.map(r => r.mod_id));
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Daily Claim APIs
app.post('/api/points/claim/:type', authenticateToken, async (req, res) => {
    const type = req.params.type; 
    const discord_id = req.user.discord_id;
    const amountMap = {
        'login-reward': 10,
        'daily-reward': 20,
        'play-reward': 10,
        'online-reward': 5
    };
    const amount = amountMap[type] || 0;
    
    if (amount === 0) return res.status(400).json({ error: 'Invalid claim type' });

    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        
        if (type === 'daily-reward') {
            const { rows: todayClaims } = await query(
                "SELECT reason FROM point_logs WHERE discord_id = $1 AND reason LIKE 'Claimed: %' AND created_at >= $2",
                [discord_id, startOfDay.getTime()]
            );
            const hasLogin = todayClaims.some(c => c.reason === 'Claimed: login-reward');
            const hasPlay = todayClaims.some(c => c.reason === 'Claimed: play-reward');
            const onlineCount = todayClaims.filter(c => c.reason === 'Claimed: online-reward').length;
            
            if (!hasLogin || !hasPlay || onlineCount < 6) {
                return res.status(400).json({ error: 'You must claim Login, Play, and all 6 Online rewards first!' });
            }
        }

        const { rows } = await query(
            'SELECT created_at FROM point_logs WHERE discord_id = $1 AND reason = $2 AND created_at >= $3 ORDER BY created_at DESC',
            [discord_id, `Claimed: ${type}`, startOfDay.getTime()]
        );

        const limit = type === 'online-reward' ? 6 : 1;
        if (rows.length >= limit) {
            return res.status(400).json({ error: type === 'online-reward' ? 'Reached maximum online rewards for today (6/6)' : 'Already claimed today' });
        }
        
        if (type === 'online-reward' && rows.length > 0) {
            const lastClaim = rows[0].created_at;
            const ONE_HOUR = 60 * 60 * 1000;
            if (Date.now() - lastClaim < ONE_HOUR) {
                return res.status(400).json({ error: 'Must wait 1 hour between online claims' });
            }
        }

        await query('UPDATE users SET points = points + $1 WHERE discord_id = $2', [amount, discord_id]);
        await query('INSERT INTO point_logs (discord_id, points_change, reason, created_at) VALUES ($1, $2, $3, $4)', [discord_id, amount, `Claimed: ${type}`, Date.now()]);
        
        res.json({ success: true, message: `Claimed ${amount} points for ${type}` });
    } catch (e) {
        res.status(500).json({ error: 'Claim failed' });
    }
});



app.get('/chat/history', async (req, res, next) => {
    const limit = Math.min(parseInt(req.query.limit || String(config.maxChatHistory), 10), 200);
    try {
        res.json(await getChatHistory(limit));
    } catch (e) { next(e); }
});

app.get('/vip/list', async (req, res, next) => {
    try {
        res.json(await listVipNames());
    } catch (e) { next(e); }
});

// Admin: add VIP user (requires ADMIN_TOKEN)
app.post('/admin/vip', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!config.adminToken || token !== config.adminToken) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { name, password } = req.body || {};
    if (typeof name !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'name and password required' });
    }
    if (name.length < 2 || name.length > 20 || password.length < 6) {
        return res.status(400).json({ error: 'name 2-20 chars, password min 6 chars' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        await query(
            `INSERT INTO vip_users (name, password_hash) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
            [name.trim(), hash]
        );
        res.json({ success: true, name: name.trim() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- PROMO CODE ROUTES ---
app.post('/api/redeem-promo', authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;
        const discord_id = req.user.id;

        if (!code) {
            return res.status(400).json({ error: 'Code is required' });
        }

        // Check if code exists and is valid
        const { rows: promoRows } = await query('SELECT * FROM promo_codes WHERE code = $1', [code]);
        if (promoRows.length === 0) {
            return res.status(404).json({ error: 'Invalid code' });
        }

        const promo = promoRows[0];

        // Check expiration
        if (promo.expires_at && Date.now() > promo.expires_at) {
            return res.status(400).json({ error: 'Code has expired' });
        }

        // Check usage limits
        if (promo.max_uses !== -1 && promo.current_uses >= promo.max_uses) {
            return res.status(400).json({ error: 'Code usage limit reached' });
        }

        // Check if user already claimed
        const { rows: historyRows } = await query('SELECT * FROM promo_redemptions WHERE code = $1 AND discord_id = $2', [code, discord_id]);
        if (historyRows.length > 0) {
            return res.status(400).json({ error: 'You have already redeemed this code' });
        }

        // Process redemption
        await query('BEGIN');
        
        // Grant points
        await query('UPDATE users SET points = points + $1 WHERE discord_id = $2', [promo.points, discord_id]);
        
        // Log points
        await query('INSERT INTO point_logs (discord_id, points_change, reason, created_at) VALUES ($1, $2, $3, $4)', [discord_id, promo.points, `Redeemed promo code: ${code}`, Date.now()]);
        
        // Update code uses
        await query('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE code = $1', [code]);
        
        // Record claim
        await query('INSERT INTO promo_redemptions (code, discord_id, created_at) VALUES ($1, $2, $3)', [code, discord_id, Date.now()]);

        await query('COMMIT');

        res.json({ success: true, message: `Successfully redeemed code for ${promo.points} points!`, points: promo.points });

    } catch (e) {
        await query('ROLLBACK');
        console.error('Redeem Promo Error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/admin/setup-promo', async (req, res) => {
    try {
        const code = req.query.code || process.env.INITIAL_PROMO_CODE;
        const points = parseInt(req.query.points) || parseInt(process.env.INITIAL_PROMO_POINTS) || 2222;

        await query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
                code VARCHAR(50) PRIMARY KEY,
                points INT NOT NULL,
                max_uses INT DEFAULT -1,
                current_uses INT DEFAULT 0,
                expires_at BIGINT,
                created_at BIGINT NOT NULL
            );
        `);
        
        await query(`
            CREATE TABLE IF NOT EXISTS promo_redemptions (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) REFERENCES promo_codes(code),
                discord_id VARCHAR(255) REFERENCES users(discord_id),
                created_at BIGINT NOT NULL,
                UNIQUE(code, discord_id)
            );
        `);

        if (code) {
            await query(`
                INSERT INTO promo_codes (code, points, created_at)
                VALUES ($1, $2, $3)
                ON CONFLICT (code) DO NOTHING;
            `, [code, points, Date.now()]);
            return res.send(`Promo tables created and code ${code} for ${points} points added successfully!`);
        }

        res.send('Promo tables created successfully! (No code provided. Use ?code=YOURCODE&points=100 to add one)');
    } catch (e) {
        res.status(500).send('Error: ' + e.message);
    }
});

app.get('/api/admin/add-promo', async (req, res) => {
    try {
        const code = req.query.code;
        const points = parseInt(req.query.points);

        if (!code || isNaN(points)) {
            return res.status(400).send('Error: Please provide both code and points. Example: /api/admin/add-promo?code=GIFT50&points=50');
        }

        await query(`
            INSERT INTO promo_codes (code, points, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (code) DO NOTHING;
        `, [code, points, Date.now()]);

        res.send(`✅ Success! Created new code: <b>${code}</b> for <b>${points}</b> points.`);
    } catch (e) {
        res.status(500).send('Error: ' + e.message);
    }
});

// --- SETUP ROUTE ---
app.get('/api/admin/setup-rewards', async (req, res) => {
    try {
        const { rows } = await query('SELECT * FROM rewards WHERE target_id = $1', ['HoNOpenACD']);
        const thaiDesc = 'ปรับแต่งตัวเกม Heroes of Newerth (ปลดล็อกมุมกล้อง)';
        
        if (rows.length === 0) {
            await query(
                `INSERT INTO rewards (name, description, reward_type, target_id, cost, stock, image_url)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                ['HoN Open ACD', thaiDesc, 'mod', 'HoNOpenACD', 2222, -1, 'points card/icon.png']
            );
            res.send('Reward added successfully!');
        } else {
            await query(
                `UPDATE rewards SET description = $1 WHERE target_id = $2`,
                [thaiDesc, 'HoNOpenACD']
            );
            res.send('Reward description updated to Thai!');
        }
    } catch (e) {
        res.status(500).send('Error setting up rewards: ' + e.message);
    }
});

// =====================================================
// HTTP + Socket.IO
// =====================================================
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: config.allowedOrigins, methods: ['GET', 'POST'] },
    pingInterval: 25000,
    pingTimeout: 60000,
});

let onlineCount = 0;
const rateLimitMap = new Map();
const takenNicknames = new Map();

function isNicknameTaken(name) {
    if (!name) return null;
    return takenNicknames.has(name.toLowerCase());
}
function registerNickname(name, socketId) {
    takenNicknames.set(name.toLowerCase(), { originalName: name, socketId });
}
function releaseNickname(socketId) {
    for (const [key, info] of takenNicknames.entries()) {
        if (info.socketId === socketId) {
            takenNicknames.delete(key);
            return info.originalName;
        }
    }
    return null;
}

// In-memory cache of VIP names (lowercase) — refreshed on startup + after admin add
let vipNamesSet = new Set();
async function refreshVipCache() {
    const names = await listVipNames();
    vipNamesSet = new Set(names.map(n => n.toLowerCase()));
    console.log(`[VIP] Loaded ${names.length} reserved names`);
}

io.on('connection', (socket) => {
    onlineCount++;
    console.log(`User connected. Online: ${onlineCount}`);
    io.emit('onlineCount', onlineCount);

    // Send recent chat history to newly connected client
    getChatHistory(config.maxChatHistory).then(history => {
        socket.emit('chat-history', history);
    }).catch(e => console.error('Failed to load chat history:', e.message));

    socket.on('set-nickname', (nickname) => {
        if (typeof nickname !== 'string') return;
        const trimmed = nickname.trim();
        if (trimmed.length === 0 || trimmed.length > 20) {
            socket.emit('nickname-rejected', { reason: 'INVALID_LENGTH' });
            return;
        }

        const oldLower = socket.nickname ? socket.nickname.toLowerCase() : null;
        if (oldLower && takenNicknames.get(oldLower)?.socketId === socket.id) {
            takenNicknames.delete(oldLower);
        }

        const requestedLower = trimmed.toLowerCase();
        const isVipRequested = vipNamesSet.has(requestedLower);
        const isAuthenticatedVip = socket.vipName && socket.vipName.toLowerCase() === requestedLower;

        if (isVipRequested && !isAuthenticatedVip) {
            socket.emit('nickname-rejected', { reason: 'VIP_REQUIRED', requested: trimmed });
            return;
        }

        const existing = takenNicknames.get(requestedLower);
        if (existing && existing.socketId !== socket.id) {
            socket.emit('nickname-rejected', { reason: 'TAKEN', requested: trimmed });
            return;
        }

        socket.nickname = trimmed;
        socket.vipName = isAuthenticatedVip ? requestedLower : null;
        socket.isVip = !!socket.vipName;
        registerNickname(trimmed, socket.id);
        socket.emit('nickname-accepted', { nickname: trimmed, isVip: socket.isVip });
        console.log(`Socket ${socket.id} set nickname: ${trimmed}${socket.isVip ? ' [VIP]' : ''}`);
    });

    socket.on('vip-auth', async (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const { name, password } = payload;
        if (typeof name !== 'string' || typeof password !== 'string') return;

        try {
            const user = await getVipUser(name);
            if (!user) {
                socket.emit('vip-auth-result', { success: false, reason: 'UNKNOWN_VIP' });
                return;
            }
            const ok = await bcrypt.compare(password, user.password_hash);
            if (!ok) {
                socket.emit('vip-auth-result', { success: false, reason: 'BAD_PASSWORD', name: user.name });
                console.log(`[VIP] Failed auth for ${user.name} from socket ${socket.id}`);
                return;
            }
            socket.vipName = user.name;
            socket.isVip = true;
            socket.emit('vip-auth-result', { success: true, name: user.name });
            console.log(`[VIP] Granted ${user.name} to socket ${socket.id}`);
        } catch (e) {
            console.error('[VIP] auth error:', e.message);
            socket.emit('vip-auth-result', { success: false, reason: 'INTERNAL' });
        }
    });

    socket.on('chat-message', async (msg) => {
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > 200) return;

        const now = Date.now();
        const lastMsg = rateLimitMap.get(socket.id) || 0;
        if (now - lastMsg < config.chatRateLimitMs) return;
        rateLimitMap.set(socket.id, now);

        const chatMsg = {
            nickname: socket.nickname || 'Anonymous',
            message: msg.trim(),
            timestamp: now,
            id: socket.id,
            isVip: !!socket.isVip,
        };

        io.emit('chat-message', chatMsg);
        try {
            await insertChatMessage(chatMsg);
        } catch (e) {
            console.error('Failed to persist chat message:', e.message);
        }
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        console.log(`User disconnected. Online: ${onlineCount}`);
        rateLimitMap.delete(socket.id);
        const releasedName = releaseNickname(socket.id);
        if (releasedName) console.log(`Released nickname: ${releasedName}`);
        io.emit('onlineCount', onlineCount);
    });
});

// =====================================================
// Error handling
// =====================================================
app.use((err, req, res, next) => {
    console.error('Unhandled API error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// =====================================================
// Bootstrap
// =====================================================
async function runInitSql() {
    // Look for init.sql next to package.json + in /app/data on the container
    const candidates = [
        path.join(__dirname, 'init.sql'),
        '/app/init.sql',
        path.join('/app/data', 'init.sql'),
        path.join(process.cwd(), 'init.sql'),
    ];
    const file = candidates.find(p => p && fs.existsSync(p));
    if (!file) {
        console.log('[DB] No init.sql found, skipping migrations');
        return;
    }
    console.log(`[DB] Applying migrations from ${file}`);
    const sql = fs.readFileSync(file, 'utf8');
    try {
        await query(sql);
        console.log('[DB] Migrations applied');
    } catch (e) {
        console.error('[DB] Migration error:', e.message);
        throw e;
    }
}

async function loadEnvPromos() {
    const extraPromos = process.env.EXTRA_PROMOS;
    if (!extraPromos) return;

    const promos = extraPromos.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of promos) {
        const [code, pts] = p.split(':');
        const points = parseInt(pts);
        if (code && !isNaN(points)) {
            try {
                await query(`
                    INSERT INTO promo_codes (code, points, created_at)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (code) DO NOTHING;
                `, [code.trim(), points, Date.now()]);
                console.log(`[PROMO] Loaded promo code from env: ${code.trim()} for ${points} pts`);
            } catch(e) {
                console.error(`[PROMO] Error loading code ${code}:`, e.message);
            }
        }
    }
}

async function start() {
    try {
        await query('SELECT 1');
        console.log('[DB] Connected to PostgreSQL');
        await runInitSql();
        await loadEnvPromos();
        await refreshVipCache();
        server.listen(config.port, () => {
            console.log(`Server listening on port ${config.port} (${config.nodeEnv})`);
        });
    } catch (e) {
        console.error('[FATAL] Failed to start:', e.message || e);
        process.exit(1);
    }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
        pool.end().then(() => process.exit(0));
    });
});
process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down...');
    server.close(() => {
        pool.end().then(() => process.exit(0));
    });
});