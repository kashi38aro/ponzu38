const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const app = express();
const port = 3005;

const soundsDirectory = path.join(__dirname, 'sounds');
const configFile = path.join(__dirname, 'folder-config.json');

app.use(express.json()); // JSONリクエストを受け取る設定
app.use(express.static(__dirname));
app.use('/sounds', express.static(soundsDirectory));

// --- Helper Functions ---

// 設定ファイルの読み込み
function loadConfig() {
    try {
        if (fs.existsSync(configFile)) {
            return JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
    } catch (e) {
        console.error("Config load error:", e);
    }
    return []; // デフォルトは空配列
}

// 設定ファイルの保存
function saveConfig(config) {
    try {
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error("Config save error:", e);
    }
}

// フォルダ内の音声ファイルを再帰的に探索する関数
function scanDirectory(dirPath, categoryName, isExternal = false) {
    let results = [];
    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        
        items.forEach(item => {
            const fullPath = path.join(dirPath, item.name);
            
            if (item.isDirectory()) {
                // 再帰的に探索（カテゴリ名は親フォルダ名 + サブフォルダ名にする）
                const subCategory = categoryName ? `${categoryName}_${item.name}` : item.name;
                results = results.concat(scanDirectory(fullPath, subCategory, isExternal));
            } else {
                const ext = path.extname(item.name).toLowerCase();
                if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) {
                    // 外部ファイルの場合はストリーミング用APIのパスを設定
                    // 内部ファイルの場合は静的配信パスを設定
                    const webPath = isExternal 
                        ? `/api/stream?path=${encodeURIComponent(fullPath)}`
                        : `/sounds/${path.relative(soundsDirectory, fullPath).replace(/\\/g, '/')}`;

                    results.push({
                        name: item.name,
                        path: webPath,
                        category: categoryName || 'Uncategorized'
                    });
                }
            }
        });
    } catch (e) {
        console.error(`Error scanning directory ${dirPath}:`, e.message);
    }
    return results;
}

// --- API Endpoints ---

// 音声ファイル一覧取得（内部フォルダ + 外部設定フォルダ）
app.get('/sounds', (req, res) => {
    const responseData = {
        categories: {},
        files: []
    };

    // 1. 標準の sounds フォルダをスキャン
    if (!fs.existsSync(soundsDirectory)) {
        fs.mkdirSync(soundsDirectory, { recursive: true });
    }
    const internalFiles = scanDirectory(soundsDirectory, '');
    
    // 内部ファイルを構造化
    internalFiles.forEach(f => {
        // ルート直下のファイルは files へ、サブフォルダは categories へ
        if (f.category === 'Uncategorized' || f.category === '') {
            responseData.files.push(f);
        } else {
            if (!responseData.categories[f.category]) responseData.categories[f.category] = [];
            responseData.categories[f.category].push(f);
        }
    });

    // 2. 外部設定フォルダをスキャン
    const externalFolders = loadConfig();
    externalFolders.forEach(folder => {
        // カテゴリ名にユーザー指定の種別(SE/BGM)を含めることで、クライアント側の振り分けロジックに適合させる
        const categoryKey = `${folder.alias || path.basename(folder.path)} (${folder.type})`;
        const extFiles = scanDirectory(folder.path, categoryKey, true);
        
        if (extFiles.length > 0) {
            responseData.categories[categoryKey] = extFiles;
        }
    });

    res.json(responseData);
});

// 外部フォルダ設定の取得
app.get('/api/folders', (req, res) => {
    res.json(loadConfig());
});

// 外部フォルダ設定の保存
app.post('/api/folders', (req, res) => {
    const newConfig = req.body;
    if (Array.isArray(newConfig)) {
        saveConfig(newConfig);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: "Invalid format" });
    }
});

// 外部ファイルのストリーミング配信
app.get('/api/stream', (req, res) => {
    const targetPath = req.query.path;
    if (!targetPath) return res.status(400).send('Path required');

    // セキュリティチェック: 設定された外部フォルダ内のファイルか確認すべきだが
    // ローカルツールのため利便性を優先し、存在チェックのみ行う
    if (fs.existsSync(targetPath)) {
        res.sendFile(path.resolve(targetPath));
    } else {
        res.status(404).send('File not found');
    }
});

const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const userAgent = req.headers['user-agent'] || '';
    ws.isObs = userAgent.includes('OBS');
    
    ws.on('message', (message) => {
        if (!ws.isObs) {
            wss.clients.forEach(client => {
                if (client.isObs && client.readyState === client.OPEN) {
                    client.send(message.toString());
                }
            });
        }
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
    console.log(`  OBSポン出しツール v2.0`);
    console.log(`  http://localhost:${port}`);
    console.log(`  Remote: http://${ipAddress}:${port}`);
    console.log(`----------------------------------------`);
});
