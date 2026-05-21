const express = require('express');
const rateLimit = require('express-rate-limit');
const { sendGroupMessage, listGroups, getStatus } = require('./whatsapp');

const router = express.Router();

const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || '60', 10);
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';

const lastRequestMap = new Map();

const VALID_TYPES = {
    garson: 'Garson Cagiriyor',
    hesap: 'Hesap Istiyor',
};

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
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
        'RESTORAN BILDIRIMI',
        `Masa: ${masa}`,
        `Istek: ${istek}`,
        `Saat: ${formatTrTime()}`,
    ].join('\n');
}

function buildEmojiMessage({ masa, istek }) {
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
        const groups = await listGroups();
        res.json({ ok: true, groups });
    } catch (err) {
        res.status(503).json({ ok: false, error: err.message });
    }
});

router.post('/upload-auth', async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    try {
        const { files } = req.body;
        if (!files || typeof files !== 'object') {
            return res.status(400).json({ ok: false, error: 'files object required' });
        }
        
        const authDir = process.env.AUTH_DIR || './auth_info';
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }
        
        let count = 0;
        for (const [filename, content] of Object.entries(files)) {
            const safeName = path.basename(filename);
            const filePath = path.join(authDir, safeName);
            fs.writeFileSync(filePath, content, 'utf8');
            count++;
        }
        
        res.json({ ok: true, uploaded: count, authDir });
    } catch (err) {
        console.error('[API] /upload-auth error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/notify', apiLimiter, async (req, res) => {
    try {
        const { masa, type } = req.body || {};

        if (!masa || typeof masa !== 'string' && typeof masa !== 'number') {
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
            return res.status(503).json({ ok: false, error: 'WhatsApp baglantisi henuz hazir degil. Lutfen birkac saniye sonra tekrar deneyin.' });
        }

        const cooldownKey = `${masaStr}`;
        const now = Date.now();
        const last = lastRequestMap.get(cooldownKey) || 0;
        const elapsed = (now - last) / 1000;
        if (elapsed < COOLDOWN_SECONDS) {
            const remaining = Math.ceil(COOLDOWN_SECONDS - elapsed);
            return res.status(429).json({
                ok: false,
                error: `Lutfen ${remaining} saniye sonra tekrar deneyin.`,
                cooldownRemaining: remaining,
            });
        }
        lastRequestMap.set(cooldownKey, now);

        const text = buildEmojiMessage({ masa: masaStr, istek });
        await sendGroupMessage(GROUP_ID, text);

        return res.json({
            ok: true,
            message: 'Bildirim gonderildi.',
            cooldownSeconds: COOLDOWN_SECONDS,
        });
    } catch (err) {
        console.error('[API] /notify hata:', err);
        return res.status(500).json({ ok: false, error: err.message || 'Sunucu hatasi.' });
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
