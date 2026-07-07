export interface SessionUser {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
    permissions: string[];
}
/**
 * Verifies username + password credentials.
 * Returns the session user object on success, null on failure.
 * Always writes a LoginLog entry.
 */
export declare function verifyCredentials(username: string, password: string, ipAddress: string, userAgent: string): Promise<SessionUser | null>;
/**
 * Changes a user's password after verifying the current password.
 * Also syncs the new hash to the shared users-qris.json file if the user exists there.
 */
export declare function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>;
