require('dotenv').config();

const express = require('express');
const cors = require('cors');

const apiRouter = require('./src/routes');
const { startWhatsApp } = require('./src/whatsapp');

process.env.TZ = process.env.TZ || 'Europe/Istanbul';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Trust proxy for correct client IP detection behind reverse proxies like Railway
app.set('trust proxy', 1);

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '*';
const allowedOrigins = allowedOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.includes('*') || !origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: ${origin} is not allowed.`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Upload-Secret'],
    credentials: false,
    maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

app.use('/api', apiRouter);

app.get('/', (req, res) => {
    res.json({
        name: 'QR Waiter Calling API',
        version: '2.0.0',
        endpoints: ['/api/health', 'POST /api/notify'],
    });
});

// Centralized error handler
app.use((err, req, res, next) => {
    console.error('[ERR]', err.message);
    res.status(500).json({ ok: false, error: 'Internal server error.' });
});

app.listen(PORT, () => {
    console.log(`[HTTP] Server is running on port :${PORT}`);
    console.log(`[HTTP] Timezone: ${process.env.TZ}`);
    console.log(`[HTTP] Allowed origins: ${allowedOriginsEnv}`);
});

startWhatsApp().catch((err) => {
    console.error('[WA] Initialization error:', err);
});

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
