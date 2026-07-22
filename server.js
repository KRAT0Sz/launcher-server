const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check endpoint for hosting platforms
app.get('/', (req, res) => {
    res.send('HoN Reborn Mod Launcher Counter API is running.');
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
