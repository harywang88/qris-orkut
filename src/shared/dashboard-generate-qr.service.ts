import crypto from 'crypto';
import type { QrisAccount } from '@prisma/client';
import { db } from '../config/database';
import { config } from '../config';
import { encrypt } from '../core/encryption';
import { appGateway } from './gateways/app-orkut.gateway';
import { mockGateway } from './gateways/mock-orkut.gateway';
import { createAmountLock, findUniqueCode } from './amount-lock.service';

const DASHBOARD_CLIENT_PANEL_CODE = 'DASHGEN';

export interface DashboardGenerateQrInput {
  accountId: string;
  amount: number;
  username: string;
  createdBy: string;
}

export interface DashboardGenerateQrResult {
  transactionId: string;
  qrId: string;
  username: string;
  siteLabel: string;
  createdAt: string;
  expiresAt: string;
  amount: number;
  status: 'UNPAID';
  botLabel: '-';
  note: string;
  qrisAccount: {
    code: string;
    merchantName: string;
  };
  qrPayload: string;
  qrImageBase64: string;
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 100);
}

function buildDashboardNote(account: Pick<QrisAccount, 'code'>, username: string, amount: number, createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/\D/g, '').slice(0, 14);
  return `MANUAL-${account.code}-${username}-${stamp} | Rp ${amount.toLocaleString('id-ID')}`;
}

async function ensureDashboardManualClient() {
  const existing = await db.client.findUnique({
    where: { panelCode: DASHBOARD_CLIENT_PANEL_CODE },
  });

  if (existing) return existing;

  const apiKey = `qris_dashboard_${crypto.randomBytes(12).toString('hex')}`;
  const apiSecretEncrypted = encrypt(crypto.randomBytes(32).toString('hex'));

  return db.client.create({
    data: {
      name: 'Dashboard Generate',
      panelCode: DASHBOARD_CLIENT_PANEL_CODE,
      apiKey,
      apiSecretEncrypted,
      status: 'active',
    },
  });
}

async function resolveDashboardQrisTemplate(account: QrisAccount): Promise<string> {
  const liveTerms = await appGateway.fetchQrisMerchantTerms(account).catch(() => null);
  const qrisData = liveTerms?.qrisData || account.qrisPayload;

  if (!qrisData) {
    throw new Error('QRIS template tidak tersedia untuk akun ini');
  }

  if (liveTerms?.qrisData && liveTerms.qrisData !== account.qrisPayload) {
    await db.qrisAccount.update({
      where: { id: account.id },
      data: { qrisPayload: liveTerms.qrisData },
    }).catch(() => {});
  }

  return qrisData;
}

export async function generateDashboardQrTransaction(
  input: DashboardGenerateQrInput,
): Promise<DashboardGenerateQrResult> {
  const username = normalizeUsername(input.username);
  if (!username) {
    throw new Error('Username wajib diisi');
  }
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new Error('Nominal minimal Rp 1');
  }
  if (input.amount > 10_000_000) {
    throw new Error('Nominal maksimal Rp 10.000.000');
  }

  const account = await db.qrisAccount.findUnique({
    where: { id: input.accountId },
  });

  if (!account || account.status !== 'active') {
    throw new Error('Akun QRIS tidak ditemukan atau tidak aktif');
  }

  const qrisData = await resolveDashboardQrisTemplate(account);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.QR_EXPIRY_MINUTES * 60 * 1000);
  const manualClient = await ensureDashboardManualClient();

  const transactionId = crypto.randomUUID();

  const result = await db.$transaction(async (tx) => {
    const { uniqueCode, finalAmount } = await findUniqueCode(
      tx,
      account.id,
      account.code,
      input.amount,
    );

    const note = buildDashboardNote(account, username, finalAmount, createdAt);
    const qrSourceAccount: QrisAccount = {
      ...account,
      qrisPayload: qrisData,
    };
    const qrResult = await mockGateway.generateQr(qrSourceAccount, finalAmount, note);

    const txRecord = await tx.transaction.create({
      data: {
        id: transactionId,
        clientId: manualClient.id,
        userIdExt: username,
        qrisAccountId: account.id,
        requestedAmount: input.amount,
        uniqueCode,
        finalAmount,
        note,
        qrPayload: qrResult.qrPayload,
        qrImageBase64: qrResult.qrImageBase64,
        feeAmount: 0,
        statusPay: 'open',
        statusBot: 'pending',
        expiresAt,
        metadataJson: JSON.stringify({
          source: 'dashboard_generate',
          site: '-',
          createdBy: input.createdBy,
        }),
      },
    });

    await createAmountLock(tx, {
      qrisAccountId: account.id,
      requestedAmount: input.amount,
      uniqueCode,
      finalAmount,
      expiresAt,
      transactionId,
    });

    await tx.qrisAccount.update({
      where: { id: account.id },
      data: { usedToday: { increment: finalAmount } },
    });

    return {
      txRecord,
      qrResult,
    };
  });

  const tx = result.txRecord;

  return {
    transactionId: tx.id,
    qrId: tx.qrId,
    username,
    siteLabel: '-',
    createdAt: tx.createdAt.toISOString(),
    expiresAt: tx.expiresAt.toISOString(),
    amount: tx.finalAmount,
    status: 'UNPAID',
    botLabel: '-',
    note: tx.note,
    qrisAccount: {
      code: account.code,
      merchantName: account.merchantName,
    },
    qrPayload: result.qrResult.qrPayload,
    qrImageBase64: result.qrResult.qrImageBase64,
  };
}
