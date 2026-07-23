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

io.on('connection', (socket) => {
    onlineCount++;
    console.log(`User connected. Online: ${onlineCount}`);
    
    // Broadcast the updated count to everyone
    io.emit('onlineCount', onlineCount);

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        console.log(`User disconnected. Online: ${onlineCount}`);
        
        // Broadcast the updated count
        io.emit('onlineCount', onlineCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
