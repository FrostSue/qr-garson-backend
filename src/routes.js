const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { sendGroupMessage, getStatus, getGroups } = require('./whatsapp');

const router = express.Router();

const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || '60', 10);
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
const TARGET_LAT = parseFloat(process.env.TARGET_LAT || '41.2505');
const TARGET_LNG = parseFloat(process.env.TARGET_LNG || '29.0205');
const ALLOWED_RADIUS = parseInt(process.env.ALLOWED_RADIUS_METERS || '250', 10);

const lastRequestMap = new Map();

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const VALID_TYPES = {
    garson: 'Garson Cagiriyor',
    hesap: 'Hesap Istiyor',
};

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests. Please wait a bit.' },
});

const notifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many notification requests. Please wait.' },
});

function formatTrTime(date = new Date()) {
    return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
}

function buildMessage({ masa, istek }) {
    return [
        '\u{1F6A8} RESTORAN B\u0130LD\u0130R\u0130M\u0130',
        `\u{1F4CD} Masa: ${masa}`,
        `\u{1F514} \u0130stek: ${istek}`,
        `\u{1F552} Saat: ${formatTrTime()}`,
    ].join('\n');
}

router.get('/health', (req, res) => {
    res.json({
        ok: true,
        whatsapp: getStatus(),
        cooldownSeconds: COOLDOWN_SECONDS,
        groupConfigured: Boolean(GROUP_ID),
    });
});

router.get('/groups', async (req, res) => {
    try {
        const secret = req.headers['x-upload-secret'] || req.query.secret;
        if (!UPLOAD_SECRET || secret !== UPLOAD_SECRET) {
            return res.status(401).json({ ok: false, error: 'Unauthorized.' });
        }
        const groups = await getGroups();
        return res.json({ ok: true, groups });
    } catch (err) {
        console.error('[API] /groups error:', err);
        return res.status(500).json({ ok: false, error: 'Internal server error.' });
    }
});

router.post('/notify', apiLimiter, notifyLimiter, async (req, res) => {
    try {
        const { masa, type, lat, lng } = req.body || {};

        if (!masa || (typeof masa !== 'string' && typeof masa !== 'number')) {
            return res.status(400).json({ ok: false, error: 'Table number is required.' });
        }

        const masaStr = String(masa).trim().slice(0, 16);
        if (!/^[A-Za-z0-9\-_]+$/.test(masaStr)) {
            return res.status(400).json({ ok: false, error: 'Invalid table number.' });
        }

        const istek = VALID_TYPES[type];
        if (!istek) {
            return res.status(400).json({ ok: false, error: 'Invalid request type (must be garson or hesap).' });
        }

        if (!lat || !lng) {
            return res.status(400).json({ ok: false, error: 'Location information is required.' });
        }

        const clientLat = parseFloat(lat);
        const clientLng = parseFloat(lng);
        if (isNaN(clientLat) || isNaN(clientLng)) {
            return res.status(400).json({ ok: false, error: 'Invalid location information.' });
        }

        const distance = calculateDistance(clientLat, clientLng, TARGET_LAT, TARGET_LNG);
        if (distance > ALLOWED_RADIUS) {
            return res.status(403).json({ ok: false, error: 'Notifications cannot be sent from outside the restaurant.' });
        }

        if (!GROUP_ID) {
            return res.status(500).json({ ok: false, error: 'Server not configured: WHATSAPP_GROUP_ID is missing.' });
        }

        const status = getStatus();
        if (!status.ready) {
            return res.status(503).json({ ok: false, error: 'WhatsApp connection is not ready. Please try again in a few seconds.' });
        }

        const now = Date.now();
        const last = lastRequestMap.get(masaStr) || 0;
        const elapsed = (now - last) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            const remaining = Math.ceil(COOLDOWN_SECONDS - elapsed);
            return res.status(429).json({
                ok: false,
                error: `Please try again in ${remaining} seconds.`,
                cooldownRemaining: remaining,
            });
        }
        lastRequestMap.set(masaStr, now);

        const text = buildMessage({ masa: masaStr, istek });
        await sendGroupMessage(GROUP_ID, text);

        return res.json({
            ok: true,
            message: 'Notification sent.',
            cooldownSeconds: COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('[API] /notify error:', err);
        return res.status(500).json({ ok: false, error: 'Internal server error.' });
    }
});

router.post('/upload-auth', (req, res, next) => {
    if (!UPLOAD_SECRET) {
        return res.status(403).json({ ok: false, error: 'Upload endpoint is disabled. UPLOAD_SECRET is not configured.' });
    }
    const secret = req.headers['x-upload-secret'];
    if (!secret || secret !== UPLOAD_SECRET) {
        console.warn('[API] /upload-auth unauthorized access attempt');
        return res.status(401).json({ ok: false, error: 'Unauthorized.' });
    }
    next();
}, async (req, res) => {
    try {
        const { files } = req.body;
        if (!files || typeof files !== 'object' || Array.isArray(files)) {
            return res.status(400).json({ ok: false, error: 'files object is required.' });
        }

        const authDir = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_info');
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }

        let count = 0;
        for (const [filename, content] of Object.entries(files)) {
            const safeName = path.basename(filename);
            if (!safeName.endsWith('.json')) continue;
            fs.writeFileSync(path.join(authDir, safeName), content, 'utf8');
            count++;
        }

        res.json({ ok: true, uploaded: count, authDir });
    } catch (err) {
        console.error('[API] /upload-auth error:', err);
        res.status(500).json({ ok: false, error: 'Internal server error.' });
    }
});

setInterval(() => {
    const now = Date.now();
    const ttl = COOLDOWN_SECONDS * 1000 * 4;
    for (const [k, v] of lastRequestMap.entries()) {
        if (now - v > ttl) lastRequestMap.delete(k);
    }
}, 5 * 60 * 1000).unref();

module.exports = router;
