/**
 * Prisma seed script.
 * Run: npm run db:seed
 *
 * Creates:
 *   - 5 permissions
 *   - 3 roles (super-admin, admin, operator) with permission assignments
 *   - 1 admin user (from env ADMIN_DEFAULT_USERNAME/ADMIN_DEFAULT_PASSWORD)
 *   - optional demo clients and demo QRIS accounts when SEED_DEMO_DATA=true
 */

import { PrismaClient } from '@prisma/client';
import bcryptjs from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

function encryptLocal(plaintext: string): string {
  const keyHex = process.env.APP_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'APP_ENCRYPTION_KEY must be set to exactly 64 hex chars in .env before seeding',
    );
  }

  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

const STATIC_QRIS_PAYLOAD = (merchantName: string, code: string): string =>
  `00020101021226590014ID.CO.QRIS.WWW011893600009${code}02150000000000000003036040000520459995303360540550001.005802ID5920${merchantName.toUpperCase().slice(0, 20).padEnd(20)}6013JAKARTA PUSAT62070503***6304ABCD`;

const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');
  const seedDemoData = String(process.env.SEED_DEMO_DATA || '').toLowerCase() === 'true';

  const permissionDefs = [
    { name: 'qris:manage', description: 'Kelola akun QRIS dan pengaturan terkait' },
    { name: 'client:manage', description: 'Kelola klien dan API key' },
    { name: 'report:view', description: 'Lihat laporan dan ringkasan' },
    { name: 'setting:manage', description: 'Ubah pengaturan sistem' },
    { name: 'log:view', description: 'Lihat log login dan audit' },
  ];

  const permissions: Record<string, { id: string; name: string }> = {};
  for (const def of permissionDefs) {
    const perm = await db.permission.upsert({
      where: { name: def.name },
      update: { description: def.description },
      create: def,
    });
    permissions[perm.name] = perm;
    console.log(`  Permission: ${perm.name}`);
  }

  const roleDefs = [
    {
      name: 'super-admin',
      description: 'Akses penuh ke semua fitur',
      perms: ['qris:manage', 'client:manage', 'report:view', 'setting:manage', 'log:view'],
    },
    {
      name: 'admin',
      description: 'Akses admin standar',
      perms: ['qris:manage', 'client:manage', 'report:view', 'setting:manage'],
    },
    {
      name: 'operator',
      description: 'Akses terbatas untuk operasional',
      perms: ['report:view', 'log:view'],
    },
  ];

  const roles: Record<string, { id: string; name: string }> = {};
  for (const def of roleDefs) {
    const role = await db.role.upsert({
      where: { name: def.name },
      update: { description: def.description },
      create: { name: def.name, description: def.description },
    });
    roles[role.name] = role;

    for (const permName of def.perms) {
      await db.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permissions[permName].id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permissions[permName].id,
        },
      });
    }

    console.log(`  Role: ${role.name}`);
  }

  const adminUsername = process.env.ADMIN_DEFAULT_USERNAME || 'Harywang';
  const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'Vinisia1234@@';
  const passwordHash = await bcryptjs.hash(adminPassword, 12);

  const adminUser = await db.user.upsert({
    where: { username: adminUsername },
    update: {
      passwordHash,
      fullName: 'Administrator',
      status: 'active',
      mustChangePassword: false,
    },
    create: {
      username: adminUsername,
      passwordHash,
      fullName: 'Administrator',
      status: 'active',
      mustChangePassword: false,
    },
  });

  await db.userRole.upsert({
    where: {
      userId_roleId: {
        userId: adminUser.id,
        roleId: roles['super-admin'].id,
      },
    },
    update: {},
    create: {
      userId: adminUser.id,
      roleId: roles['super-admin'].id,
    },
  });

  console.log(`  Admin user: ${adminUsername}`);

  const clientDefs = [
    { name: 'Website A', panelCode: 'WA' },
    { name: 'Website B', panelCode: 'WB' },
    { name: 'Website C', panelCode: 'WC' },
  ];

  if (seedDemoData) {
    for (const def of clientDefs) {
      const existing = await db.client.findUnique({ where: { panelCode: def.panelCode } });
      if (existing) {
        console.log(`  Demo client ${def.name} already exists, skipping`);
        continue;
      }

      const apiKey = `qris_${def.panelCode.toLowerCase()}_${crypto.randomBytes(12).toString('hex')}`;
      const rawSecret = crypto.randomBytes(32).toString('hex');
      const apiSecretEncrypted = encryptLocal(rawSecret);

      await db.client.create({
        data: {
          name: def.name,
          panelCode: def.panelCode,
          apiKey,
          apiSecretEncrypted,
          status: 'active',
        },
      });

      console.log(`  Demo client created: ${def.name}`);
      console.log(`    API Key:    ${apiKey}`);
      console.log(`    API Secret: ${rawSecret}`);
    }
  } else {
    console.log('  Demo clients skipped (set SEED_DEMO_DATA=true to create sample data)');
  }

  const qrisAccountDefs = [
    {
      code: '01WR',
      accountNumber: '0813000000001',
      merchantName: 'Warung Ramah',
      orkutAccountIndex: 1,
    },
    {
      code: '02BS',
      accountNumber: '0813000000002',
      merchantName: 'Bintang Sejahtera',
      orkutAccountIndex: 2,
    },
    {
      code: '03MP',
      accountNumber: '0813000000003',
      merchantName: 'Maju Pesat',
      orkutAccountIndex: 3,
    },
  ];

  if (seedDemoData) {
    for (const def of qrisAccountDefs) {
      await db.qrisAccount.upsert({
        where: { code: def.code },
        update: {},
        create: {
          code: def.code,
          accountNumber: def.accountNumber,
          merchantName: def.merchantName,
          orkutAccountIndex: def.orkutAccountIndex,
          status: 'active',
          healthStatus: 'healthy',
          dailyLimit: 30_000_000,
          usedToday: 0,
          qrisPayload: STATIC_QRIS_PAYLOAD(def.merchantName, def.code),
        },
      });
      console.log(`  Demo QRIS account created: ${def.code} - ${def.merchantName}`);
    }
  } else {
    console.log('  Demo QRIS accounts skipped (set SEED_DEMO_DATA=true to create sample data)');
  }

  for (const walletCode of ['utama', 'madera']) {
    const existing = await db.walletLedger.findFirst({ where: { walletCode } });
    if (!existing) {
      await db.walletLedger.create({
        data: {
          walletCode,
          amount: 0,
          refType: 'adjustment',
          description: 'Saldo awal (seed)',
          balanceAfter: 0,
        },
      });
      console.log(`  WalletLedger initialized: ${walletCode}`);
    } else {
      console.log(`  WalletLedger ${walletCode} already initialized, skipping`);
    }
  }

  console.log('\nSeeding complete.');
  const port = process.env.PORT || '3333';
  const basePath = process.env.APP_BASE_PATH || '/qris';
  console.log(`  Login at http://localhost:${port}${basePath}/login`);
  console.log(`  Username: ${adminUsername}`);
  console.log(`  Password: ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
