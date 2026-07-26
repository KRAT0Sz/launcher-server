const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Parse JSON bodies (as sent by API clients)
app.use(express.json());

// ============ VIP / Reserved Names Config ============
// Format: "Nickname1:password1,Nickname2:password2"
const VIP_CONFIG = (process.env.VIP_PASSWORDS || 'Dev:dev123')
    .split(/[,;
]/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
        const match = entry.match(/^([^:=!@]+)[:=!@](.+)$/);
        if (!match) return null;
        return {
            name: match[1].trim().toLowerCase(),
            password: match[2].trim()
        };
    })
    .filter(Boolean);
const VIP_NAMES = new Set(VIP_CONFIG.map(v => v.name));

const downloadsFile = path.join(__dirname, 'downloads.json');
let modDownloads = {};

if (fs.existsSync(downloadsFile)) {
    try {
        modDownloads = JSON.parse(fs.readFileSync(downloadsFile, 'utf8'));
    } catch (e) {
        console.error("Error reading downloads.json", e);
    }
}

function saveDownloads() {
    fs.writeFileSync(downloadsFile, JSON.stringify(modDownloads));
}

// Health check endpoint for hosting platforms
app.get('/', (req, res) => {
    res.send('HoN Reborn Mod Launcher Counter API is running.');
});

// Get all downloads
app.get('/downloads', (req, res) => {
    res.json(modDownloads);
});

// Increment download for a mod
app.post('/downloads/:modId', (req, res) => {
    const { modId } = req.params;
    modDownloads[modId] = (modDownloads[modId] || 0) + 1;
    saveDownloads();
    res.json({ success: true, total: modDownloads[modId] });
});

let githubCache = { data: null, lastFetch: 0 };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get GitHub Releases Proxy
app.get('/github-releases', async (req, res) => {
    const now = Date.now();
    if (githubCache.data && (now - githubCache.lastFetch < CACHE_DURATION)) {
        console.log('Serving GitHub releases from cache');
        return res.json(githubCache.data);
    }

    try {
        console.log('Fetching GitHub releases from API...');
        // Optional: you can add authorization headers if you set a GITHUB_TOKEN in your .env
        const headers = { 'User-Agent': 'HoNModLauncher-Counter-Server' };
        if (process.env.GITHUB_TOKEN) {
            headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        }

        const response = await fetch('https://api.github.com/repos/KRAT0Sz/hon-mod/releases', { headers });
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        
        const data = await response.json();
        githubCache.data = data;
        githubCache.lastFetch = now;
        
        res.json(data);
    } catch (error) {
        console.error('GitHub Fetch Error:', error.message);
        // Fallback to cache even if expired
        if (githubCache.data) {
            return res.json(githubCache.data);
        }
        res.status(500).json({ error: 'Failed to fetch from GitHub' });
    }
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", // allow from anywhere (since it's an Electron app)
        methods: ["GET", "POST"]
    }
});

let onlineCount = 0;
const chatHistory = []; // Keep last 50 messages in memory
const MAX_CHAT_HISTORY = 50;
const rateLimitMap = new Map(); // socket.id -> last message timestamp
const takenNicknames = new Map(); // lowercase nickname -> { originalName, socketId }

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

io.on('connection', (socket) => {
    onlineCount++;
    console.log(`User connected. Online: ${onlineCount}`);

    // Broadcast the updated count to everyone
    io.emit('onlineCount', onlineCount);

    // Send chat history to newly connected client
    socket.emit('chat-history', chatHistory);

    // Handle setting nickname
    socket.on('set-nickname', (nickname) => {
        if (typeof nickname !== 'string') return;
        const trimmed = nickname.trim();
        if (trimmed.length === 0 || trimmed.length > 20) {
            socket.emit('nickname-rejected', { reason: 'INVALID_LENGTH' });
            return;
        }

        // Release previous nickname for this socket (if any)
        const oldLower = socket.nickname ? socket.nickname.toLowerCase() : null;
        if (oldLower && takenNicknames.get(oldLower)?.socketId === socket.id) {
            takenNicknames.delete(oldLower);
        }

        // VIP names are reserved — require explicit VIP auth first
        // (case-insensitive check against the reserved list)
        const requestedLower = trimmed.toLowerCase();
        const isVipRequested = VIP_NAMES.has(requestedLower);
        const isAuthenticatedVip = socket.vipName && socket.vipName.toLowerCase() === requestedLower;

        if (isVipRequested && !isAuthenticatedVip) {
            socket.emit('nickname-rejected', { reason: 'VIP_REQUIRED', requested: trimmed });
            return;
        }

        // Check duplicate (case-insensitive) — exclude self
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

    // VIP authentication: verify password and grant permission to use reserved name
    socket.on('vip-auth', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const { name, password } = payload;
        if (typeof name !== 'string' || typeof password !== 'string') return;

        const nameLower = name.trim().toLowerCase();
        const vip = VIP_CONFIG.find(v => v.name === nameLower);
        if (!vip) {
            socket.emit('vip-auth-result', { success: false, reason: 'UNKNOWN_VIP' });
            return;
        }
        if (vip.password !== password) {
            socket.emit('vip-auth-result', { success: false, reason: 'BAD_PASSWORD', name: vip.name });
            console.log(`[VIP] Failed auth for ${vip.name} from socket ${socket.id}`);
            return;
        }
        socket.vipName = vip.name;
        socket.isVip = true;
        socket.emit('vip-auth-result', { success: true, name: vip.name });
        console.log(`[VIP] Granted ${vip.name} to socket ${socket.id}`);
    });

    // Handle chat messages
    socket.on('chat-message', (msg) => {
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > 200) return;

        // Rate limit: 1 message per second per user
        const now = Date.now();
        const lastMsg = rateLimitMap.get(socket.id) || 0;
        if (now - lastMsg < 1000) return;
        rateLimitMap.set(socket.id, now);

        const chatMsg = {
            nickname: socket.nickname || 'Anonymous',
            message: msg.trim(),
            timestamp: now,
            id: socket.id,
            isVip: !!socket.isVip
        };

        chatHistory.push(chatMsg);
        if (chatHistory.length > MAX_CHAT_HISTORY) {
            chatHistory.shift();
        }

        // Broadcast to everyone
        io.emit('chat-message', chatMsg);
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        console.log(`User disconnected. Online: ${onlineCount}`);
        rateLimitMap.delete(socket.id);
        const releasedName = releaseNickname(socket.id);
        if (releasedName) {
            console.log(`Released nickname: ${releasedName}`);
        }

        // Broadcast the updated count
        io.emit('onlineCount', onlineCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
