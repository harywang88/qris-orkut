import crypto from 'crypto';
import http from 'http';
import { db } from '../src/config/database';
import { decrypt } from '../src/core/encryption';

async function makeRequest(apiKey: string, secret: string, nonce: string): Promise<number> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = Buffer.from(JSON.stringify({ userId: 'replay-test', amount: 10000 }));
  const bodyHex = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = ['POST', '/api/v1/qris/generate', ts, nonce, bodyHex].join('\n');
  const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/api/v1/qris/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-API-Key': apiKey,
          'X-Timestamp': ts,
          'X-Nonce': nonce,
          'X-Signature': sig,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.write(body);
    req.end();
  });
}

async function main() {
  const client = await db.client.findFirst({ where: { panelCode: 'WA' } });
  if (!client) { console.error('Client WA not found'); process.exit(1); }
  const secret = decrypt(client.apiSecretEncrypted);
  const nonce = `replay-${crypto.randomBytes(8).toString('hex')}`;

  console.log('--- Replay Attack Test ---');
  const r1 = await makeRequest(client.apiKey, secret, nonce);
  console.log(`First  request (nonce: ${nonce.slice(0, 20)}...): HTTP ${r1} ${r1 === 201 ? '✓' : '✗'}`);

  const r2 = await makeRequest(client.apiKey, secret, nonce);
  console.log(`Replay request (same nonce):                  HTTP ${r2} ${r2 === 409 ? '✓ REPLAY REJECTED' : '✗ EXPECTED 409'}`);

  await db.$disconnect();
}

main().catch(console.error);
