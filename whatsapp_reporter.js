const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const http = require('http');

let globalSock = null;
let globalJid = null;

// Database configuration from environment variables
const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'manufacturing_erp'
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Suppress excessive logs
        printQRInTerminal: false // We will handle it manually using qrcode-terminal
    });
    
    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan the QR code below to link WhatsApp:');
            qrcode.generate(qr, { small: true });
            require('fs').writeFileSync('qr_code.txt', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            require('fs').writeFileSync('qr_code.txt', 'CONNECTED');
            console.log('WhatsApp connected successfully!');
            
            // Send connection success message to the connected user's own number
            const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            globalJid = userJid;
            
            await sock.sendMessage(userJid, { 
                text: '✅ *Manufacturing ERP*\nWhatsApp integration has been connected successfully! You will now receive automated reports here.' 
            });

            // Start the reporting cron job
            startReportingCron(sock, userJid);
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

// HTTP Server to accept API requests
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
    
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/send') {
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
            try { require('fs').unlinkSync('qr_code.txt'); } catch(e){}
            try { require('fs').rmSync('baileys_auth_info', { recursive: true, force: true }); } catch(e){}
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
