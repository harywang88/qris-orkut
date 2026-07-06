import { Router } from 'express';
import {
  handleWidgetGenerate,
  handleWidgetStatus,
  handleWidgetOptions,
} from './widget.controller';

/**
 * Public, browser-facing widget API (alfael-style ?key=…).
 * No HMAC, no session — authenticated by widget key + Origin allowlist.
 * Mounted at /widget (and {basePath}/widget) in app.ts.
 */
const router = Router();

router.options('/generate', handleWidgetOptions);
router.options('/status', handleWidgetOptions);

router.get('/generate', handleWidgetGenerate);
router.get('/status', handleWidgetStatus);

export { router as widgetRouter };
