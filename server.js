const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const app = express();
const port = 3005;

const soundsDirectory = path.join(__dirname, 'sounds');

// --- HTTP Server Setup ---
app.use(express.static(__dirname));
app.use('/sounds', express.static(soundsDirectory));

app.get('/sounds', (req, res) => {
    fs.readdir(soundsDirectory, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') {
                fs.mkdirSync(soundsDirectory, { recursive: true });
                return res.json([]);
            }
            console.error("Could not list the directory.", err);
            return res.status(500).send('Server error');
        }
        const audioFiles = files.filter(file => 
            ['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(path.extname(file).toLowerCase())
        );
        res.json(audioFiles);
    });
});

const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const userAgent = req.headers['user-agent'] || '';
    // 接続クライアントにOBSかどうかを判別するフラグを持たせる
    ws.isObs = userAgent.includes('OBS');

    console.log(`Client connected: ${ws.isObs ? 'OBS Player' : 'Remote Control'}`);

    ws.on('message', (message) => {
        // リモコンからのメッセージで、かつOBSクライアントが接続している場合のみ転送
        if (!ws.isObs) {
            wss.clients.forEach(client => {
                if (client.isObs && client.readyState === client.OPEN) {
                    client.send(message.toString());
                }
            });
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${ws.isObs ? 'OBS Player' : 'Remote Control'}`);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error on client:', error);
    });
});

server.listen(port, '0.0.0.0', () => {
    const networkInterfaces = os.networkInterfaces();
    let ipAddress = 'localhost';
    
    Object.keys(networkInterfaces).forEach(ifaceName => {
        networkInterfaces[ifaceName].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address;
            }
        });
    });

    console.log(`----------------------------------------`);
    console.log(`  OBSポン出しツール サーバー起動完了`);
    console.log(`  `);
    console.log(`  OBSブラウザソースURL (PC上で設定):`);
    console.log(`  http://localhost:${port}`);
    console.log(`  `);
    console.log(`  リモコンURL (スマホ等でアクセス):`);
    console.log(`  http://${ipAddress}:${port}`);
    console.log(`----------------------------------------`);
});
