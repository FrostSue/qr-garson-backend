const fs = require('fs');
const path = require('path');
const https = require('https');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://qr-garson-backend-production.up.railway.app';
const AUTH_DIR = './auth_info';

async function uploadAuthFiles() {
    const files = {};
    const authFiles = fs.readdirSync(AUTH_DIR);
    
    console.log(`[UPLOAD] ${authFiles.length} dosya bulundu`);
    
    for (const file of authFiles) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(AUTH_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        files[file] = content;
    }
    
    const payload = JSON.stringify({ files });
    const url = new URL('/api/upload-auth', RAILWAY_URL);
    
    console.log(`[UPLOAD] ${Object.keys(files).length} JSON dosyasi yukleniyor...`);
    console.log(`[UPLOAD] Hedef: ${url.href}`);
    
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log('[UPLOAD] Basarili:', data);
                    resolve(JSON.parse(data));
                } else {
                    console.error('[UPLOAD] Hata:', res.statusCode, data);
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

uploadAuthFiles()
    .then(() => {
        console.log('[UPLOAD] Tamamlandi! Simdi Railway\'i yeniden baslatin.');
        process.exit(0);
    })
    .catch(err => {
        console.error('[UPLOAD] Basarisiz:', err.message);
        process.exit(1);
    });
