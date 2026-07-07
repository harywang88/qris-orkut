"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyCredentials = verifyCredentials;
exports.changePassword = changePassword;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const SHARED_QRIS_USERS_FILE = path_1.default.resolve(process.cwd(), '..', 'DASHBOARD', 'member-site', 'cloud', 'cloud', 'data', 'users-qris.json');
/**
 * Verifies username + password credentials.
 * Returns the session user object on success, null on failure.
 * Always writes a LoginLog entry.
 */
async function verifyCredentials(username, password, ipAddress, userAgent) {
    let user = await findUserWithRoles(username);
    if (!user || user.status !== 'active') {
        const sharedUser = await verifySharedQrisUser(username, password);
        if (!sharedUser) {
            await writeLoginLog({ userId: null, username, ipAddress, userAgent, status: 'failed' });
            return null;
        }
        user = await syncSharedQrisUser(sharedUser.username, sharedUser.passwordHash);
    }
    else {
        const passwordValid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!passwordValid) {
            const sharedUser = await verifySharedQrisUser(username, password);
            if (!sharedUser) {
                logger_1.logger.warn({ username, ip: ipAddress }, 'Failed login attempt');
                await writeLoginLog({ userId: user.id, username, ipAddress, userAgent, status: 'failed' });
                return null;
            }
            user = await syncSharedQrisUser(sharedUser.username, sharedUser.passwordHash, user.id);
        }
        else {
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
                    const jsonPasswordValid = await bcryptjs_1.default.compare(password, jsonHash);
                    if (!jsonPasswordValid) {
                        // Admin has reset password — old password no longer valid
                        logger_1.logger.warn({ username, ip: ipAddress }, 'Admin reset detected: denying login with old password');
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
    const permissions = new Set();
    for (const userRole of user.userRoles) {
        for (const rp of userRole.role.rolePermissions) {
            permissions.add(rp.permission.name);
        }
    }
    // Update last login info
    await database_1.db.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ipAddress },
    });
    await writeLoginLog({ userId: user.id, username, ipAddress, userAgent, status: 'success' });
    logger_1.logger.info({ username, ip: ipAddress }, 'Successful login');
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
async function changePassword(userId, currentPassword, newPassword) {
    const existingUser = await database_1.db.user.findUnique({ where: { id: userId } });
    if (!existingUser)
        throw new Error('User tidak ditemukan');
    // Verify current password against Prisma DB
    const currentValid = await bcryptjs_1.default.compare(currentPassword, existingUser.passwordHash);
    if (!currentValid) {
        // Prisma may be out of sync with JSON — also check JSON
        const jsonUsers = loadSharedQrisUsers();
        const needle = existingUser.username.toLowerCase();
        const jsonKey = Object.keys(jsonUsers).find((k) => k.toLowerCase() === needle);
        if (jsonKey) {
            const entry = jsonUsers[jsonKey];
            const jsonHash = String(entry?.password || entry?.passwordHash || '').trim();
            const jsonValid = jsonHash ? await bcryptjs_1.default.compare(currentPassword, jsonHash) : false;
            if (!jsonValid) {
                throw new Error('Password saat ini tidak benar');
            }
        }
        else {
            throw new Error('Password saat ini tidak benar');
        }
    }
    const passwordHash = await bcryptjs_1.default.hash(newPassword, 12);
    // Update JSON first (so login remains consistent if Prisma update fails)
    const jsonUsers = loadSharedQrisUsers();
    const needle = existingUser.username.toLowerCase();
    const jsonKey = Object.keys(jsonUsers).find((k) => k.toLowerCase() === needle);
    if (jsonKey) {
        try {
            jsonUsers[jsonKey].password = passwordHash;
            fs_1.default.writeFileSync(SHARED_QRIS_USERS_FILE, JSON.stringify(jsonUsers, null, 2), 'utf8');
        }
        catch (err) {
            logger_1.logger.error({ err }, 'Failed to sync new password to shared QRIS users file');
            throw new Error('Gagal menyimpan password baru. Silakan coba lagi.');
        }
    }
    // Then update Prisma DB
    await database_1.db.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
    });
}
// ── Helpers ─────────────────────────────────────────────────────────────────
async function writeLoginLog(data) {
    try {
        await database_1.db.loginLog.create({
            data: {
                userId: data.userId,
                username: data.username,
                ipAddress: data.ipAddress,
                userAgent: data.userAgent,
                status: data.status,
            },
        });
    }
    catch (err) {
        // Non-fatal — don't let log failure break auth
        logger_1.logger.error({ err }, 'Failed to write login log');
    }
}
async function findUserWithRoles(username) {
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
    const exactUser = await database_1.db.user.findUnique({
        where: { username },
        include: includeRoles,
    });
    if (exactUser && exactUser.username.toLowerCase() === needle) {
        return exactUser;
    }
    const users = await database_1.db.user.findMany({
        where: {
            username: { in: [username, String(username || '').toLowerCase(), String(username || '').toUpperCase()] },
        },
        include: includeRoles,
    });
    return users.find((user) => user.username.toLowerCase() === needle) || null;
}
function loadSharedQrisUsers() {
    try {
        if (!fs_1.default.existsSync(SHARED_QRIS_USERS_FILE))
            return {};
        const raw = JSON.parse(fs_1.default.readFileSync(SHARED_QRIS_USERS_FILE, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    }
    catch (err) {
        logger_1.logger.error({ err, file: SHARED_QRIS_USERS_FILE }, 'Failed to load shared QRIS users file');
        return {};
    }
}
async function verifySharedQrisUser(username, password) {
    const users = loadSharedQrisUsers();
    const matchedUsername = Object.keys(users).find((key) => key.toLowerCase() === String(username || '').trim().toLowerCase()) || '';
    if (!matchedUsername)
        return null;
    const entry = users[matchedUsername];
    const passwordHash = String(entry?.password || entry?.passwordHash || '').trim();
    if (!passwordHash)
        return null;
    const passwordValid = await bcryptjs_1.default.compare(password, passwordHash);
    if (!passwordValid)
        return null;
    return {
        username: matchedUsername,
        passwordHash,
    };
}
async function syncSharedQrisUser(sharedUsername, passwordHash, existingUserId) {
    const role = (await database_1.db.role.findUnique({ where: { name: 'super-admin' } })) ||
        (await database_1.db.role.findUnique({ where: { name: 'admin' } }));
    if (!role) {
        throw new Error('Role admin QRIS tidak ditemukan di database');
    }
    const dbUser = await database_1.db.user.upsert({
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
    }).catch(async () => database_1.db.user.upsert({
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
    }));
    await database_1.db.userRole.upsert({
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
//# sourceMappingURL=auth.service.js.map