"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.widgetRouter = void 0;
const express_1 = require("express");
const widget_controller_1 = require("./widget.controller");
/**
 * Public, browser-facing widget API (alfael-style ?key=…).
 * No HMAC, no session — authenticated by widget key + Origin allowlist.
 * Mounted at /widget (and {basePath}/widget) in app.ts.
 */
const router = (0, express_1.Router)();
exports.widgetRouter = router;
router.options('/generate', widget_controller_1.handleWidgetOptions);
router.options('/status', widget_controller_1.handleWidgetOptions);
router.get('/generate', widget_controller_1.handleWidgetGenerate);
router.get('/status', widget_controller_1.handleWidgetStatus);
//# sourceMappingURL=widget.router.js.map