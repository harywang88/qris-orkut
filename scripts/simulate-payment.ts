/**
 * simulate-payment.ts
 *
 * Development utility: inject a mock mutation into the database to simulate
 * a QRIS payment being received. The worker's mutation-poll loop (Prompt 2)
 * will pick it up, match it to the open transaction, and trigger deposit.
 *
 * Usage:
 *   npm run simulate-payment -- --qrId=<qrId>
 *
 * Example:
 *   npm run simulate-payment -- --qrId=cm9abc123...
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.join(__dirname, '../.env') });

const db = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const qrIdArg = args.find((a) => a.startsWith('--qrId='));

  if (!qrIdArg) {
    console.error('Usage: npm run simulate-payment -- --qrId=<qrId>');
    process.exit(1);
  }

  const qrId = qrIdArg.replace('--qrId=', '').trim();

  // Find the open transaction
  const tx = await db.transaction.findUnique({
    where: { qrId },
    include: { qrisAccount: true },
  });

  if (!tx) {
    console.error(`Transaction not found for qrId: ${qrId}`);
    process.exit(1);
  }

  if (tx.statusPay !== 'open') {
    console.error(`Transaction is already ${tx.statusPay} (not open)`);
    process.exit(1);
  }

  if (new Date() > tx.expiresAt) {
    console.error('Transaction has expired');
    process.exit(1);
  }

  // Create a mock mutation matching the transaction's finalAmount
  const rawData = {
    simulatedAt: new Date().toISOString(),
    amount: tx.finalAmount,
    issuer: 'MOCK_BANK',
    rrn: `SIM${Date.now()}`,
    transactionId: tx.id,
  };

  const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');

  const mutation = await db.mutation.create({
    data: {
      qrisAccountId: tx.qrisAccountId,
      amount: tx.finalAmount,
      type: 'credit',
      balanceBefore: 1_000_000,
      balanceAfter: 1_000_000 + tx.finalAmount,
      issuerName: 'MOCK_BANK',
      rrn: rawData.rrn,
      transactionTime: new Date(),
      rawHash,
      rawDataJson: JSON.stringify(rawData),
    },
  });

  console.log('✅ Mock mutation created:', mutation.id);
  console.log(`   Amount:  Rp ${tx.finalAmount.toLocaleString('id-ID')}`);
  console.log(`   Account: ${tx.qrisAccount.code} — ${tx.qrisAccount.merchantName}`);
  console.log('');
  console.log('The worker mutation-poll loop will match this mutation within ~1.5 seconds.');
  console.log('Watch the worker logs for: "Mutation matched", "Deposit queued", "Deposit succeeded".');
}

main()
  .catch((e) => {
    console.error('Simulation failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
