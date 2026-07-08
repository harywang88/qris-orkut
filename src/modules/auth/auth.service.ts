import bcryptjs from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { verifyAliasLogin } from '../../shared/alias-access.service';

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  permissions: string[];
  isAlias?: boolean;
}

type SharedQrisUserRecord = {
  id?: number;
  password?: string;
  passwordHash?: string;
  fullName?: string;
  createdAt?: string;
};

const SHARED_QRIS_USERS_FILE = path.resolve(
  process.cwd(),
  '..',
  'DASHBOARD',
  'member-site',
  'cloud',
  'cloud',
  'data',
  'users-qris.json',
);

/**
 * Verifies username + password credentials.
 * Returns the session user object on success, null on failure.
 * Always writes a LoginLog entry.
 */
export async function verifyCredentials(
  username: string,
  password: string,
  ipAddress: string,
  userAgent: string,
): Promise<SessionUser | null> {
  let user = await findUserWithRoles(username);

  if (!user || user.status !== 'active') {
    const sharedUser = await verifySharedQrisUser(username, password);
    if (!sharedUser) {
      // Fallback terakhir: akun Alias (RBAC ringan, alias-accounts.json) -> sesi terpisah isAlias.
      const aliasUser = await verifyAliasLogin(username, password);
      if (aliasUser) {
        await writeLoginLog({ userId: null, username: aliasUser.username, ipAddress, userAgent, status: 'success' });
        return {
          id: 'alias:' + aliasUser.username,
          username: aliasUser.username,
          fullName: aliasUser.name,
          mustChangePassword: false,
          permissions: [],
          isAlias: true,
        };
      }
      await writeLoginLog({ userId: null, username, ipAddress, userAgent, status: 'failed' });
      return null;
    }
    user = await syncSharedQrisUser(sharedUser.username, sharedUser.passwordHash);
  } else {
    const passwordValid = await bcryptjs.compare(password, user.passwordHash);
    if (!passwordValid) {
      const sharedUser = await verifySharedQrisUser(username, password);
      if (!sharedUser) {
        logger.warn({ username, ip: ipAddress }, 'Failed login attempt');
        await writeLoginLog({ userId: user.id, username, ipAddress, userAgent, status: 'failed' });
        return null;
      }
      user = await syncSharedQrisUser(sharedUser.username, sharedUser.passwordHash, user.id);
    } else {
      // Prisma matched — also check JSON to detect admin password reset.
      // If user exists in JSON but the password no longer matches JSON hash,
      // it means admin has reset the password. Deny the old password.
      const jsonUsers = loadSharedQrisUsers();
      const needle = String(username || '').trim().toLowerCase();
      const jsonKey = Object.keys(jsonUsers).find((k) => k.toLowerCase() === needle);
      if (jsonKey) {
        const entry = jsonUsers[jsonKey];
        const jsonHash = String(entry?.password || entry?.passwordHash || '').trim();
        if (jsonHash) {
          const jsonPasswordValid = await bcryptjs.compare(password, jsonHash);
          if (!jsonPasswordValid) {
            // Admin has reset password — old password no longer valid
            logger.warn({ username, ip: ipAddress }, 'Admin reset detected: denying login with old password');
            await writeLoginLog({ userId: user.id, username, ipAddress, userAgent, status: 'failed' });
            return null;
          }
          // Both Prisma and JSON match — already in sync, no re-sync needed
        }
      }
    }
  }

  if (!user) {
    await writeLoginLog({ userId: null, username, ipAddress, userAgent, status: 'failed' });
    return null;
  }

  // Collect permissions from all roles
  const permissions = new Set<string>();
  for (const userRole of user.userRoles) {
    for (const rp of userRole.role.rolePermissions) {
      permissions.add(rp.permission.name);
    }
  }

  // Update last login info
  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), lastLoginIp: ipAddress },
  });

  await writeLoginLog({ userId: user.id, username, ipAddress, userAgent, status: 'success' });

  logger.info({ username, ip: ipAddress }, 'Successful login');

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    permissions: Array.from(permissions),
  };
}

/**
 * Changes a user's password after verifying the current password.
 * Also syncs the new hash to the shared users-qris.json file if the user exists there.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const existingUser = await db.user.findUnique({ where: { id: userId } });
  if (!existingUser) throw new Error('User tidak ditemukan');

  // Verify current password against Prisma DB
  const currentValid = await bcryptjs.compare(currentPassword, existingUser.passwordHash);
  if (!currentValid) {
    // Prisma may be out of sync with JSON — also check JSON
    const jsonUsers = loadSharedQrisUsers();
    const needle = existingUser.username.toLowerCase();
    const jsonKey = Object.keys(jsonUsers).find((k) => k.toLowerCase() === needle);
    if (jsonKey) {
      const entry = jsonUsers[jsonKey];
      const jsonHash = String(entry?.password || entry?.passwordHash || '').trim();
      const jsonValid = jsonHash ? await bcryptjs.compare(currentPassword, jsonHash) : false;
      if (!jsonValid) {
        throw new Error('Password saat ini tidak benar');
      }
    } else {
      throw new Error('Password saat ini tidak benar');
    }
  }

  const passwordHash = await bcryptjs.hash(newPassword, 12);

  // Update JSON first (so login remains consistent if Prisma update fails)
  const jsonUsers = loadSharedQrisUsers();
  const needle = existingUser.username.toLowerCase();
  const jsonKey = Object.keys(jsonUsers).find((k) => k.toLowerCase() === needle);
  if (jsonKey) {
    try {
      jsonUsers[jsonKey].password = passwordHash;
      fs.writeFileSync(SHARED_QRIS_USERS_FILE, JSON.stringify(jsonUsers, null, 2), 'utf8');
    } catch (err) {
      logger.error({ err }, 'Failed to sync new password to shared QRIS users file');
      throw new Error('Gagal menyimpan password baru. Silakan coba lagi.');
    }
  }

  // Then update Prisma DB
  await db.user.update({
    where: { id: userId },
    data: { passwordHash, mustChangePassword: false },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function writeLoginLog(data: {
  userId: string | null;
  username: string;
  ipAddress: string;
  userAgent: string;
  status: string;
}): Promise<void> {
  try {
    await db.loginLog.create({
      data: {
        userId: data.userId,
        username: data.username,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        status: data.status,
      },
    });
  } catch (err) {
    // Non-fatal — don't let log failure break auth
    logger.error({ err }, 'Failed to write login log');
  }
}

async function findUserWithRoles(username: string) {
  const needle = String(username || '').trim().toLowerCase();
  const includeRoles = {
    userRoles: {
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    },
  };

  // Prefer an exact username match first so similarly named accounts do not
  // compete with each other during login (for example: `Harywang` vs `harywang`).
  const exactUser = await db.user.findUnique({
    where: { username },
    include: includeRoles,
  });
  if (exactUser && exactUser.username.toLowerCase() === needle) {
    return exactUser;
  }

  const users = await db.user.findMany({
    where: {
      username: { in: [username, String(username || '').toLowerCase(), String(username || '').toUpperCase()] },
    },
    include: includeRoles,
  });

  return users.find((user) => user.username.toLowerCase() === needle) || null;
}

function loadSharedQrisUsers(): Record<string, SharedQrisUserRecord> {
  try {
    if (!fs.existsSync(SHARED_QRIS_USERS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(SHARED_QRIS_USERS_FILE, 'utf8')) as Record<
      string,
      SharedQrisUserRecord
    >;
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    logger.error({ err, file: SHARED_QRIS_USERS_FILE }, 'Failed to load shared QRIS users file');
    return {};
  }
}

async function verifySharedQrisUser(username: string, password: string): Promise<{
  username: string;
  passwordHash: string;
} | null> {
  const users = loadSharedQrisUsers();
  const matchedUsername =
    Object.keys(users).find((key) => key.toLowerCase() === String(username || '').trim().toLowerCase()) || '';

  if (!matchedUsername) return null;
  const entry = users[matchedUsername];
  const passwordHash = String(entry?.password || entry?.passwordHash || '').trim();
  if (!passwordHash) return null;

  const passwordValid = await bcryptjs.compare(password, passwordHash);
  if (!passwordValid) return null;

  return {
    username: matchedUsername,
    passwordHash,
  };
}

async function syncSharedQrisUser(sharedUsername: string, passwordHash: string, existingUserId?: string) {
  const role =
    (await db.role.findUnique({ where: { name: 'super-admin' } })) ||
    (await db.role.findUnique({ where: { name: 'admin' } }));

  if (!role) {
    throw new Error('Role admin QRIS tidak ditemukan di database');
  }

  const dbUser = await db.user.upsert({
    where: { id: existingUserId || `missing-${sharedUsername}` },
    update: {
      username: sharedUsername,
      passwordHash,
      fullName: sharedUsername,
      status: 'active',
      mustChangePassword: false,
    },
    create: {
      username: sharedUsername,
      passwordHash,
      fullName: sharedUsername,
      status: 'active',
      mustChangePassword: false,
    },
  }).catch(async () =>
    db.user.upsert({
      where: { username: sharedUsername },
      update: {
        passwordHash,
        fullName: sharedUsername,
        status: 'active',
        mustChangePassword: false,
      },
      create: {
        username: sharedUsername,
        passwordHash,
        fullName: sharedUsername,
        status: 'active',
        mustChangePassword: false,
      },
    }),
  );

  await db.userRole.upsert({
    where: {
      userId_roleId: {
        userId: dbUser.id,
        roleId: role.id,
      },
    },
    update: {},
    create: {
      userId: dbUser.id,
      roleId: role.id,
    },
  });

  return findUserWithRoles(dbUser.username);
}
