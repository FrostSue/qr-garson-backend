require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const apiRouter = require('./src/routes');
const { startWhatsApp } = require('./src/whatsapp');

process.env.TZ = process.env.TZ || 'Europe/Istanbul';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '*';
const allowedOrigins = allowedOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.includes('*') || !origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: ${origin} izinli degil.`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

app.use('/api', apiRouter);

app.get('/', (req, res) => {
    res.json({
        name: 'QR Garson Cagirma API',
        version: '1.0.0',
        endpoints: ['/api/health', '/api/groups', 'POST /api/notify'],
    });
});

app.use((err, req, res, next) => {
    console.error('[ERR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
    console.log(`[HTTP] Sunucu :${PORT} portunda calisiyor`);
    console.log(`[HTTP] Saat dilimi: ${process.env.TZ}`);
    console.log(`[HTTP] Izinli kaynaklar: ${allowedOriginsEnv}`);
});

startWhatsApp().catch((err) => {
    console.error('[WA] Baslatma hatasi:', err);
});

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
