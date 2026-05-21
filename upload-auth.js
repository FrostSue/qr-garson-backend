/**
 * upload-auth.js
 * Yerel auth_info/ klasöründeki WhatsApp oturum dosyalarını Railway backend'e yükler.
 *
 * Kullanım (PowerShell):
 *   $env:RAILWAY_URL="https://xxx.up.railway.app"; $env:UPLOAD_SECRET="sifren"; node upload-auth.js
 *
 * Kullanım (Mac/Linux):
 *   RAILWAY_URL=https://xxx.up.railway.app UPLOAD_SECRET=sifren node upload-auth.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://qr-garson-backend-production.up.railway.app';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const BATCH_SIZE = 5;
const TIMEOUT_MS = 30_000;

function httpRequest(urlStr, method, headers, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(urlStr);
        const lib = parsed.protocol === 'https:' ? https : http;
        const bodyBuf = Buffer.from(body || '', 'utf8');

        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': bodyBuf.length,
                ...headers,
            },
            timeout: TIMEOUT_MS,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`Zaman asimi (${TIMEOUT_MS}ms)`)); });
        req.on('error', (err) => reject(new Error(`Ag hatasi: ${err.message}`)));

        if (bodyBuf.length > 0) req.write(bodyBuf);
        req.end();
    });
}

async function checkHealth() {
    process.stdout.write('[1/3] Sunucu kontrol ediliyor... ');
    const res = await httpRequest(`${RAILWAY_URL}/api/health`, 'GET', {}, '');
    if (res.statusCode !== 200) throw new Error(`Sunucu hata dondu: HTTP ${res.statusCode}`);
    const data = JSON.parse(res.body);
    console.log(`OK (WhatsApp: ${data?.whatsapp?.ready ? 'Bagli' : 'Bekliyor'})`);
}

async function uploadBatch(files) {
    const payload = JSON.stringify({ files });
    const headers = {};
    if (UPLOAD_SECRET) headers['x-upload-secret'] = UPLOAD_SECRET;

    const res = await httpRequest(`${RAILWAY_URL}/api/upload-auth`, 'POST', headers, payload);

    if (res.statusCode === 401) throw new Error('Yetkisiz: UPLOAD_SECRET yanlis veya eksik.');
    if (res.statusCode === 403) throw new Error('Upload endpoint kapali: Railway\'de UPLOAD_SECRET tanimlanmamis.');
    if (res.statusCode !== 200) {
        let msg = `HTTP ${res.statusCode}`;
        try { msg += ': ' + JSON.parse(res.body).error; } catch { msg += ': ' + res.body.slice(0, 100); }
        throw new Error(msg);
    }
    return JSON.parse(res.body);
}

async function main() {
    console.log('=== WhatsApp Auth Uploader v2 ===');
    console.log(`Hedef : ${RAILWAY_URL}`);
    console.log(`Kaynak: ${AUTH_DIR}`);
    console.log(`Secret: ${UPLOAD_SECRET ? '***' + UPLOAD_SECRET.slice(-3) : '(tanimlanmamis!)'}`);
    console.log('');

    if (!UPLOAD_SECRET) {
        console.warn('UYARI: UPLOAD_SECRET tanimlanmamis. Railway\'de de tanimli degilse endpoint reddetecek.');
    }

    if (!fs.existsSync(AUTH_DIR)) {
        throw new Error(`auth_info klasoru bulunamadi: ${AUTH_DIR}\nOnce lokal olarak WhatsApp\'a baglanip QR okutun.`);
    }

    const allFiles = fs.readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
    if (allFiles.length === 0) throw new Error(`${AUTH_DIR} icinde hic .json dosyasi yok.`);
    console.log(`[2/3] ${allFiles.length} dosya bulundu.\n`);

    await checkHealth();

    const totalBatches = Math.ceil(allFiles.length / BATCH_SIZE);
    let totalUploaded = 0;

    console.log(`[3/3] Yukleniyor (${totalBatches} batch)...`);
    for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
        const batch = allFiles.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const files = {};
        for (const file of batch) {
            files[file] = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
        }
        process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} dosya)... `);
        const result = await uploadBatch(files);
        totalUploaded += result.uploaded;
        console.log(`OK`);
    }

    console.log('');
    console.log(`Tamamlandi! ${totalUploaded} dosya yuklendi.`);
    console.log('Railway dashboard\'dan servisi Restart et — QR istemeden baglanacak.');
}

main().then(() => process.exit(0)).catch(err => {
    console.error('\nHATA:', err.message);
    process.exit(1);
});
