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
    apiSecret: string;
    depositApiKey: string | null;
}
export declare function listClients(): Promise<ClientWithSecretPreview[]>;
export declare function getClientById(id: string): Promise<{
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
export declare function createClient(data: {
    name: string;
    panelCode: string;
    callbackUrl?: string;
    depositApiUrl?: string;
    depositApiKey?: string;
    widgetAllowedOrigins?: string;
}): Promise<{
    client: {
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
    };
    rawSecret: string;
}>;
/**
 * Generates (or regenerates) the public widget key for a client.
 * Returns the new widget key.
 */
export declare function rotateWidgetKey(id: string): Promise<string>;
export declare function updateClient(id: string, data: {
    name?: string;
    status?: string;
    callbackUrl?: string;
    depositApiUrl?: string;
    depositApiKey?: string;
    widgetAllowedOrigins?: string;
}): Promise<{
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
}>;
export declare function deleteClient(id: string): Promise<void>;
/**
 * Rotates the API secret for a client.
 * Returns the new raw secret (shown to admin once, never stored in plain text).
 */
export declare function rotateApiSecret(id: string): Promise<string>;
/**
 * Returns the decrypted API secret for display.
 * Only call this when the admin explicitly requests it.
 */
export declare function getDecryptedSecret(id: string): Promise<string>;
