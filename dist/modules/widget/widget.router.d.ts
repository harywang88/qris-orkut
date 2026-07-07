/**
 * Public, browser-facing widget API (alfael-style ?key=…).
 * No HMAC, no session — authenticated by widget key + Origin allowlist.
 * Mounted at /widget (and {basePath}/widget) in app.ts.
 */
declare const router: import("express-serve-static-core").Router;
export { router as widgetRouter };
