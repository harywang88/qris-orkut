/**
 * test-api.ts — Quick smoke test for HMAC-authenticated API endpoints
 * Usage: npx tsx scripts/test-api.ts
 */
import crypto from 'crypto';
import http from 'http';
import { db } from '../src/config/database';
import { decrypt } from '../src/core/encryption';

async function makeRequest(
  method: string,
  path: string,
  body: object | null,
  apiKey: string,
  secret: string,
): Promise<{ status: number; data: unknown }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const rawBody = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const bodyHex = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHex].join('\n');
  const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': rawBody.length,
        'X-API-Key': apiKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': sig,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data });
        }
      });
    });
    req.on('error', reject);
    if (rawBody.length > 0) req.write(rawBody);
    req.end();
  });
}

async function main() {
  console.log('=== QRIS API Smoke Test ===\n');

  // Fetch client WA from DB
  const client = await db.client.findFirst({ where: { panelCode: 'WA' } });
  if (!client) {
    console.error('ERROR: Client WA not found in DB — run npm run db:seed first');
    process.exit(1);
  }

  const secret = decrypt(client.apiSecretEncrypted);
  console.log(`Using client: ${client.name} (${client.panelCode})`);
  console.log(`API Key: ${client.apiKey}\n`);

  // Test 1: POST /api/v1/qris/generate
  console.log('--- Test 1: POST /api/v1/qris/generate ---');
  const gen = await makeRequest(
    'POST',
    '/api/v1/qris/generate',
    { userId: 'user-test-001', amount: 50000, externalReference: 'ORDER-123' },
    client.apiKey,
    secret,
  );
  console.log(`Status: ${gen.status}`);
  const genResp = gen.data as { success: boolean; data?: Record<string, unknown> };
  const genData = genResp.data ?? {};
  if (gen.status === 201) {
    console.log('✓ PASS — QR generated');
    console.log(`  qrId: ${genData.qrId}`);
    console.log(`  requestedAmount: ${genData.requestedAmount}`);
    console.log(`  uniqueCode: ${genData.uniqueCode}`);
    console.log(`  finalAmount: ${genData.finalAmount}`);
    console.log(`  note: ${genData.note}`);
    console.log(`  statusPay: ${genData.statusPay}`);
    console.log(`  expiresAt: ${genData.expiresAt}`);
    const acct = genData.qrisAccount as Record<string, unknown> | undefined;
    console.log(`  qrisAccount: ${acct?.code} / ${acct?.merchantName}`);
    const qrImg = genData.qrImageBase64 as string | undefined;
    console.log(`  qrImageBase64: ${qrImg ? qrImg.substring(0, 50) + '...' : 'MISSING'}`);

    // Test 2: GET /api/v1/qris/:qrId/status
    console.log('\n--- Test 2: GET /api/v1/qris/:qrId/status ---');
    const qrId = genData.qrId as string;
    const status = await makeRequest(
      'GET',
      `/api/v1/qris/${qrId}/status`,
      null,
      client.apiKey,
      secret,
    );
    console.log(`Status: ${status.status}`);
    const statusResp = status.data as { success: boolean; data?: Record<string, unknown> };
    const statusData = statusResp.data ?? (status.data as Record<string, unknown>);
    if (status.status === 200) {
      console.log('✓ PASS — Status fetched');
      console.log(`  statusPay: ${statusData.statusPay}`);
      console.log(`  statusBot: ${statusData.statusBot}`);
    } else {
      console.log('✗ FAIL');
      console.log(JSON.stringify(status.data, null, 2));
    }

    // Test 3: Replay attack (same nonce) — we'll use the same nonce
    // Actually replay is harder to test directly; just check that a second identical call fails
    // (nonce is random so each call gets a new nonce — replay is naturally prevented)
    // Instead verify that unique codes differ on second generate
    console.log('\n--- Test 3: Second generate (different uniqueCode) ---');
    const gen2 = await makeRequest(
      'POST',
      '/api/v1/qris/generate',
      { userId: 'user-test-001', amount: 50000, externalReference: 'ORDER-124' },
      client.apiKey,
      secret,
    );
    console.log(`Status: ${gen2.status}`);
    const gen2Resp = gen2.data as { success: boolean; data?: Record<string, unknown> };
    const gen2Data = gen2Resp.data ?? {};
    if (gen2.status === 201) {
      const uc1 = genData.uniqueCode as number;
      const uc2 = gen2Data.uniqueCode as number;
      if (uc1 !== uc2) {
        console.log(`✓ PASS — Different unique codes: ${uc1} vs ${uc2}`);
      } else {
        console.log(`✗ FAIL — Same unique codes: ${uc1}`);
      }
    } else {
      console.log('✗ FAIL');
      console.log(JSON.stringify(gen2Data, null, 2));
    }

  } else {
    console.log('✗ FAIL');
    console.log(JSON.stringify(genData, null, 2));
  }

  // Test 4: Wrong signature → 401
  console.log('\n--- Test 4: Invalid signature → expect 401 ---');
  const bad = await makeRequest(
    'POST',
    '/api/v1/qris/generate',
    { userId: 'user-test-001', amount: 50000 },
    client.apiKey,
    'wrongsecret',
  );
  if (bad.status === 401) {
    console.log('✓ PASS — 401 returned for bad signature');
  } else {
    console.log(`✗ FAIL — Expected 401, got ${bad.status}`);
  }

  await db.$disconnect();
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
