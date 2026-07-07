"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findClientByWidgetKey = findClientByWidgetKey;
exports.isOriginAllowed = isOriginAllowed;
const database_1 = require("../../config/database");
/**
 * Resolves a public widget key to its owning client.
 * Returns null if the key is unknown or the client is inactive.
 *
 * The widget key is an alfael-style browser key passed as ?key=… . It is
 * deliberately low-privilege: it can only create a QR and read the status of
 * QRs it created. It is NOT the HMAC apiSecret.
 */
async function findClientByWidgetKey(widgetKey) {
    if (!widgetKey || widgetKey.length < 16)
        return null;
    const client = await database_1.db.client.findUnique({ where: { widgetKey } });
    if (!client || client.status !== 'active')
        return null;
    return client;
}
/**
 * Normalises an origin string to scheme://host[:port] (no trailing slash/path).
 * Returns '' if it can't be parsed.
 */
function normaliseOrigin(value) {
    try {
        const u = new URL(value);
        return `${u.protocol}//${u.host}`.toLowerCase();
    }
    catch {
        return '';
    }
}
/**
 * Checks whether the request's Origin/Referer is allowed for this client.
 *
 * - If widgetAllowedOrigins is null/empty → allow any (not recommended, but
 *   mirrors alfael's default openness).
 * - Otherwise the request Origin (or Referer host) must match one entry.
 */
function isOriginAllowed(allowlist, origin, referer) {
    const list = (allowlist ?? '')
        .split(',')
        .map((s) => normaliseOrigin(s.trim()))
        .filter(Boolean);
    // No allowlist configured → open (alfael-style default).
    if (list.length === 0)
        return true;
    const candidate = normaliseOrigin(origin ?? '') || normaliseOrigin(referer ?? '');
    if (!candidate)
        return false;
    return list.includes(candidate);
}
//# sourceMappingURL=widget.service.js.map