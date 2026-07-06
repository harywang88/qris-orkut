import crypto from 'crypto';
import { db } from '../../config/database';
import { encrypt, decrypt } from '../../core/encryption';

export interface ClientWithSecretPreview {
  id: string;
  name: string;
  panelCode: string;
  apiKey: string;
  status: string;
  callbackUrl: string | null;
  depositApiUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientDetail extends ClientWithSecretPreview {
  apiSecret: string; // decrypted — only shown once after rotation
  depositApiKey: string | null;
}

export async function listClients(): Promise<ClientWithSecretPreview[]> {
  return db.client.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      panelCode: true,
      apiKey: true,
      status: true,
      callbackUrl: true,
      depositApiUrl: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getClientById(id: string) {
  return db.client.findUnique({ where: { id } });
}

export async function createClient(data: {
  name: string;
  panelCode: string;
  callbackUrl?: string;
  depositApiUrl?: string;
  depositApiKey?: string;
  widgetAllowedOrigins?: string;
}) {
  const apiKey = `qris_${data.panelCode.toLowerCase()}_${crypto.randomBytes(12).toString('hex')}`;
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const apiSecretEncrypted = encrypt(rawSecret);
  // Public browser widget key (alfael-style ?key=). Safe to expose; low-privilege.
  const widgetKey = `wk_${data.panelCode.toLowerCase()}_${crypto.randomBytes(24).toString('hex')}`;

  const client = await db.client.create({
    data: {
      name: data.name,
      panelCode: data.panelCode.toUpperCase(),
      apiKey,
      apiSecretEncrypted,
      status: 'active',
      callbackUrl: data.callbackUrl || null,
      depositApiUrl: data.depositApiUrl || null,
      depositApiKey: data.depositApiKey || null,
      widgetKey,
      widgetAllowedOrigins: data.widgetAllowedOrigins || null,
    },
  });

  return { client, rawSecret };
}

/**
 * Generates (or regenerates) the public widget key for a client.
 * Returns the new widget key.
 */
export async function rotateWidgetKey(id: string): Promise<string> {
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  const widgetKey = `wk_${client.panelCode.toLowerCase()}_${crypto.randomBytes(24).toString('hex')}`;
  await db.client.update({ where: { id }, data: { widgetKey } });
  return widgetKey;
}

export async function updateClient(
  id: string,
  data: {
    name?: string;
    status?: string;
    callbackUrl?: string;
    depositApiUrl?: string;
    depositApiKey?: string;
    widgetAllowedOrigins?: string;
  },
) {
  return db.client.update({
    where: { id },
    data: {
      name: data.name,
      status: data.status,
      callbackUrl: data.callbackUrl ?? null,
      depositApiUrl: data.depositApiUrl ?? null,
      depositApiKey: data.depositApiKey ?? null,
      widgetAllowedOrigins: data.widgetAllowedOrigins ?? null,
    },
  });
}

export async function deleteClient(id: string): Promise<void> {
  // Soft-check: don't delete clients with transactions
  const txCount = await db.transaction.count({ where: { clientId: id } });
  if (txCount > 0) {
    throw new Error(`Klien memiliki ${txCount} transaksi dan tidak dapat dihapus.`);
  }
  await db.client.delete({ where: { id } });
}

/**
 * Rotates the API secret for a client.
 * Returns the new raw secret (shown to admin once, never stored in plain text).
 */
export async function rotateApiSecret(id: string): Promise<string> {
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const apiSecretEncrypted = encrypt(rawSecret);

  await db.client.update({
    where: { id },
    data: { apiSecretEncrypted },
  });

  return rawSecret;
}

/**
 * Returns the decrypted API secret for display.
 * Only call this when the admin explicitly requests it.
 */
export async function getDecryptedSecret(id: string): Promise<string> {
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  return decrypt(client.apiSecretEncrypted);
}
