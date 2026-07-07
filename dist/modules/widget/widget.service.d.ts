/**
 * Resolves a public widget key to its owning client.
 * Returns null if the key is unknown or the client is inactive.
 *
 * The widget key is an alfael-style browser key passed as ?key=… . It is
 * deliberately low-privilege: it can only create a QR and read the status of
 * QRs it created. It is NOT the HMAC apiSecret.
 */
export declare function findClientByWidgetKey(widgetKey: string): Promise<{
    status: string;
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    panelCode: string;
    apiKey: string;
    apiSecretEncrypted: string;
    callbackUrl: string | null;
    depositApiUrl: string | null;
    depositApiKey: string | null;
    depositApiSecretEncrypted: string | null;
    allowedIps: string | null;
    widgetKey: string | null;
    widgetAllowedOrigins: string | null;
} | null>;
/**
 * Checks whether the request's Origin/Referer is allowed for this client.
 *
 * - If widgetAllowedOrigins is null/empty → allow any (not recommended, but
 *   mirrors alfael's default openness).
 * - Otherwise the request Origin (or Referer host) must match one entry.
 */
export declare function isOriginAllowed(allowlist: string | null | undefined, origin: string | undefined, referer: string | undefined): boolean;
