const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const logger = pino({ level: 'warn' });

let sock = null;
let isReady = false;
let currentQR = null;
let reconnectAttempts = 0;

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_info');

function ensureAuthDir() {
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log(`[WA] Auth folder created: ${AUTH_DIR}`);
    }
}

async function startWhatsApp() {
    ensureAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Baileys version: ${version.join('.')} (latest: ${isLatest})`);

    sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['QR-Garson', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n[WA] New QR code generated. Scan with your phone:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            isReady = true;
            currentQR = null;
            reconnectAttempts = 0;
            console.log('[WA] Connection successful. WhatsApp is ready.');
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[WA] Connection closed. statusCode=${statusCode} loggedOut=${loggedOut}`);

            if (loggedOut) {
                console.log('[WA] Session logged out. Cleaning up auth files.');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {
                    console.error('[WA] Auth cleaning error:', e.message);
                }
                return;
            }

            reconnectAttempts += 1;
            const delay = Math.min(30_000, 2_000 * reconnectAttempts);
            console.log(`[WA] Will reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
            setTimeout(() => {
                startWhatsApp().catch((err) => console.error('[WA] Reconnect error:', err));
            }, delay);
        }
    });

    return sock;
}

async function sendGroupMessage(groupId, text) {
    if (!sock || !isReady) {
        throw new Error('WhatsApp connection not ready yet.');
    }
    if (!groupId || !groupId.endsWith('@g.us')) {
        throw new Error('Invalid WhatsApp Group ID. Must be in ...@g.us format.');
    }
    return sock.sendMessage(groupId, { text });
}

async function getGroups() {
    if (!sock || !isReady) {
        throw new Error('WhatsApp connection not ready yet.');
    }
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
    }));
}

function getStatus() {
    return {
        ready: isReady,
        hasQR: Boolean(currentQR),
        authDir: AUTH_DIR,
    };
}

module.exports = {
    startWhatsApp,
    sendGroupMessage,
    getGroups,
    getStatus,
};
