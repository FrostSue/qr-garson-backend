const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { sendGroupMessage, getStatus } = require('./whatsapp');

const router = express.Router();

const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || '60', 10);
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

const lastRequestMap = new Map();

const VALID_TYPES = {
    garson: 'Garson Cagiriyor',
    hesap: 'Hesap Istiyor',
};

// Genel rate limiter — dakikada 30 istek
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Cok fazla istek. Lutfen biraz bekleyin.' },
});

// Notify icin daha siki limiter — IP basina dakikada 10 istek
const notifyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Cok fazla bildirim istegi. Lutfen bekleyin.' },
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

// ─── GET /api/health ────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
    res.json({
        ok: true,
        whatsapp: getStatus(),
        cooldownSeconds: COOLDOWN_SECONDS,
        groupConfigured: Boolean(GROUP_ID),
    });
});

// ─── POST /api/notify ────────────────────────────────────────────────────────
router.post('/notify', apiLimiter, notifyLimiter, async (req, res) => {
    try {
        const { masa, type } = req.body || {};

        if (!masa || (typeof masa !== 'string' && typeof masa !== 'number')) {
            return res.status(400).json({ ok: false, error: 'Masa numarasi gerekli.' });
        }

        const masaStr = String(masa).trim().slice(0, 16);
        if (!/^[A-Za-z0-9\-_]+$/.test(masaStr)) {
            return res.status(400).json({ ok: false, error: 'Gecersiz masa numarasi.' });
        }

        const istek = VALID_TYPES[type];
        if (!istek) {
            return res.status(400).json({ ok: false, error: 'Gecersiz istek turu. (garson | hesap)' });
        }

        if (!GROUP_ID) {
            return res.status(500).json({ ok: false, error: 'Sunucu yapilandirilmamis: WHATSAPP_GROUP_ID eksik.' });
        }

        const status = getStatus();
        if (!status.ready) {
            return res.status(503).json({ ok: false, error: 'WhatsApp baglantisi hazir degil. Lutfen birkac saniye sonra tekrar deneyin.' });
        }

        // Sunucu tarafli cooldown
        const now = Date.now();
        const last = lastRequestMap.get(masaStr) || 0;
        const elapsed = (now - last) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            const remaining = Math.ceil(COOLDOWN_SECONDS - elapsed);
            return res.status(429).json({
                ok: false,
                error: `Lutfen ${remaining} saniye sonra tekrar deneyin.`,
                cooldownRemaining: remaining,
            });
        }
        lastRequestMap.set(masaStr, now);

        const text = buildMessage({ masa: masaStr, istek });
        await sendGroupMessage(GROUP_ID, text);

        return res.json({
            ok: true,
            message: 'Bildirim gonderildi.',
            cooldownSeconds: COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('[API] /notify hata:', err);
        return res.status(500).json({ ok: false, error: 'Sunucu hatasi.' });
    }
});

// ─── POST /api/upload-auth ──────────────────────────────────────────────────
// Yerel auth dosyalarini Railway'e yukler.
// UPLOAD_SECRET env degiskeni ile korunur — bos birakilirsa endpoint kapali.
router.post('/upload-auth', (req, res, next) => {
    if (!UPLOAD_SECRET) {
        return res.status(403).json({ ok: false, error: 'Upload endpoint devre disi. UPLOAD_SECRET tanimlanmamis.' });
    }
    const secret = req.headers['x-upload-secret'];
    if (!secret || secret !== UPLOAD_SECRET) {
        console.warn('[API] /upload-auth yetkisiz erisim denemesi');
        return res.status(401).json({ ok: false, error: 'Yetkisiz.' });
    }
    next();
}, async (req, res) => {
    try {
        const { files } = req.body;
        if (!files || typeof files !== 'object' || Array.isArray(files)) {
            return res.status(400).json({ ok: false, error: 'files objesi gerekli.' });
        }

        const authDir = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_info');
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }

        let count = 0;
        for (const [filename, content] of Object.entries(files)) {
            // Path traversal koruması — sadece dosya adı al, klasör yolu kabul etme
            const safeName = path.basename(filename);
            if (!safeName.endsWith('.json')) continue;
            fs.writeFileSync(path.join(authDir, safeName), content, 'utf8');
            count++;
        }

        res.json({ ok: true, uploaded: count, authDir });
    } catch (err) {
        console.error('[API] /upload-auth hata:', err);
        res.status(500).json({ ok: false, error: 'Sunucu hatasi.' });
    }
});

// Cooldown map temizleme
setInterval(() => {
    const now = Date.now();
    const ttl = COOLDOWN_SECONDS * 1000 * 4;
    for (const [k, v] of lastRequestMap.entries()) {
        if (now - v > ttl) lastRequestMap.delete(k);
    }
}, 5 * 60 * 1000).unref();

module.exports = router;
