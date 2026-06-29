const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { useRedisAuthState, getRedisClient } = require('./redis-auth');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const http = require('http');

let globalSock = null;
let globalJid = null;
let isCronStarted = false;
let currentQR = null;
let isConnected = false;
let reconnectAttempts = 0;

// Database configuration from environment variables
const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'manufacturing_erp'
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useRedisAuthState('whatsapp_bot');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' }),
        printQRInTerminal: false,
        // Production optimizations
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30000, // 30 seconds
        syncFullHistory: false
    });
    
    globalSock = sock;

    sock.ev.on('creds.update', async () => {
        console.log('Credentials updated - saving to storage...');
        try {
            await saveCreds();
            console.log('Credentials saved successfully!');
        } catch (err) {
            console.error('Error saving credentials:', err);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('=== Connection Update ===');
        console.log('Update:', JSON.stringify(update, null, 2));
        console.log('========================');

        if (qr) {
            console.log('Scan the QR code below to link WhatsApp:');
            qrcode.generate(qr, { small: true });
            currentQR = qr;
            isConnected = false;
            try { require('fs').writeFileSync('qr_code.txt', qr); } catch(e){}
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const isConflict = lastDisconnect.error?.data?.tag === 'stream:error' && statusCode === 401;
            const isRestartRequired = statusCode === 515;
            const shouldReconnect = !isConflict && statusCode !== DisconnectReason.loggedOut;
            
            console.log('Connection closed due to:', lastDisconnect.error);
            console.log('Status code:', statusCode);
            console.log('Should reconnect:', shouldReconnect);
            
            if (shouldReconnect || isRestartRequired) {
                // Exponential backoff with jitter
                reconnectAttempts++;
                const baseDelay = isRestartRequired ? 10000 : 3000; // 10 sec for 515, 3 sec otherwise
                const maxDelay = 60000; // Max 1 minute delay
                const delay = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts), maxDelay);
                const jitter = Math.random() * 1000; // Add 0-1 sec jitter to avoid thundering herd
                
                console.log(`Reconnecting in ${Math.round((delay + jitter) / 1000)} seconds... (Attempt ${reconnectAttempts})`);
                setTimeout(() => connectToWhatsApp(), delay + jitter);
            }
        } else if (connection === 'open') {
            // Reset reconnect counter when connection succeeds
            reconnectAttempts = 0;
            isConnected = true;
            currentQR = null;
            try { require('fs').writeFileSync('qr_code.txt', 'CONNECTED'); } catch(e){}
            console.log('WhatsApp connected successfully!');
            
            // Send connection success message only once
            const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            globalJid = userJid;
            console.log('Connected as:', userJid);
            
            if (!isCronStarted) {
                try {
                    await sock.sendMessage(userJid, { 
                        text: '✅ *Manufacturing ERP*\nWhatsApp integration has been connected successfully! You will now receive automated reports here.' 
                    });
                } catch (err) {
                    console.error('Failed to send welcome message', err);
                }
                
                // Start the reporting cron job only once
                startReportingCron(sock, userJid);
                isCronStarted = true;
            }
        }
    });
}

function startReportingCron(sock, targetJid) {
    console.log('Cron scheduler started for reporting...');
    
    // Schedule for 9:00 PM every day
    cron.schedule('0 21 * * *', async () => {
        console.log('Generating daily report...');
        try {
            const connection = await mysql.createConnection(dbConfig);
            let reportText = `📊 *Daily Operations Report* - ${new Date().toLocaleDateString()}\n\n`;

            // 1. Daily Urgent Log
            const [urgentOrders] = await connection.execute(`
                SELECT p.id, c.client_name, pr.item_code, pi.boxes, pi.pieces 
                FROM purchase_orders p 
                JOIN clients c ON p.client_id = c.id
                JOIN po_items pi ON p.id = pi.po_id
                JOIN products pr ON pi.product_id = pr.id
                WHERE p.is_urgent = 1 AND p.status = 'Pending'
            `);

            reportText += `🚨 *Daily Urgent Log*\n`;
            if (urgentOrders.length > 0) {
                urgentOrders.forEach(o => {
                    reportText += `PO #${o.id} | ${o.client_name}\nItem: ${o.item_code}\nQty: ${o.boxes} Boxes, ${o.pieces} Pieces\n---\n`;
                });
            } else {
                reportText += `No urgent orders pending.\n---\n`;
            }

            // 2. Production Demands
            const [demands] = await connection.execute(`
                SELECT department_name, item_code, item_name, SUM(quantity_required) as total
                FROM department_queues 
                WHERE status = 'Pending' 
                GROUP BY department_name, item_code, item_name
            `);

            reportText += `\n⚙️ *Production Demands*\n`;
            if (demands.length > 0) {
                demands.forEach(d => {
                    reportText += `${d.department_name}\n${d.item_code} (${d.item_name}): ${d.total} needed\n\n`;
                });
            } else {
                reportText += `No raw materials pending.\n\n`;
            }

            // Send via WhatsApp
            await sock.sendMessage(targetJid, { text: reportText });
            console.log('Daily text report sent via WhatsApp!');

            await connection.end();


        } catch (error) {
            console.error('Error generating report:', error);
            await sock.sendMessage(targetJid, { text: `⚠️ Error generating daily report: ${error.message}` });
        }
    });
}


connectToWhatsApp();

// HTTP Server to accept API requests and serve static files
const fs = require('fs');
const path = require('path');

const server = http.createServer(async (req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.method === 'GET' && req.url === '/') {
        // Serve index.html
        const indexPath = path.join(__dirname, 'index.html');
        fs.readFile(indexPath, (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        });
    } else if (req.method === 'GET' && req.url === '/status') {
        // Return status and QR code
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            connected: isConnected, 
            qr: currentQR 
        }));
    } else if (req.method === 'POST' && req.url === '/send') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (globalSock && globalJid && data.message) {
                    await globalSock.sendMessage(globalJid, { text: data.message });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.end(JSON.stringify({ success: false, error: 'Not connected or no message' }));
                }
            } catch (err) {
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/logout') {
        if (globalSock) {
            try {
                await globalSock.logout();
            } catch (e) {
                console.error('Logout error', e);
            }
            try {
                const redis = await getRedisClient();
                if (redis) {
                    const keys = await redis.keys('whatsapp_bot:*');
                    if (keys.length > 0) {
                        await redis.del(keys);
                    }
                } else {
                    // Fallback to file system
                    try { fs.unlinkSync('qr_code.txt'); } catch(e){}
                    try { fs.rmSync('baileys_auth_info', { recursive: true, force: true }); } catch(e){}
                }
            } catch (e) {
                console.error('Error clearing auth data', e);
            }
            res.end(JSON.stringify({ success: true }));
            console.log('Logged out successfully. Restarting process...');
            process.exit(0);
        } else {
            res.end(JSON.stringify({ success: false, error: 'Not connected' }));
        }
    } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
