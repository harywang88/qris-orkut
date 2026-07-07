import { Request, Response } from 'express';
/**
 * GET /widget/generate?key=…&amount=…&member=…&ref=…
 *
 * Public, browser-facing (alfael-style). Authenticated only by the widget key
 * plus an Origin/Referer allowlist. Creates a QR for the client that owns the key.
 */
export declare function handleWidgetGenerate(req: Request, res: Response): Promise<void>;
/**
 * GET /widget/status?key=…&qrId=…
 *
 * Returns minimal payment status. The QR must belong to the client that owns
 * the widget key (prevents one site reading another site's transactions).
 */
export declare function handleWidgetStatus(req: Request, res: Response): Promise<void>;
/** Handles CORS preflight for the widget endpoints. */
export declare function handleWidgetOptions(req: Request, res: Response): void;
