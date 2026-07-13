import express, { Request, Response, NextFunction, Router } from 'express';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { config } from './config';
import { createSessionMiddleware } from './config/session';
import { logger } from './config/logger';
import { normalizeBasePath, withBasePath } from './core/base-path';
import { isMasterUser, getMenuPermsForUser, getSiteScopeForUser } from './shared/alias-access.service';
import { accountIdsForSite } from './shared/site.service';
import { runWithScope } from './core/request-context';
import { requireAuth } from './core/auth.middleware';
import { authRouter } from './modules/auth/auth.router';
import { dashboardRouter } from './modules/dashboard/dashboard.router';
import { qrisAccountsRouter } from './modules/qris-accounts/qris-accounts.router';
import { merchantQrRouter } from './modules/merchant-qr/merchant-qr.router';
import { clientsRouter } from './modules/clients/clients.router';
import { adminLogRouter } from './modules/admin-log/admin-log.router';
import {
  qrisClientRouter,
  qrisAdminRouter,
  qrisDevRouter,
} from './modules/transactions/transactions.router';
import { reportsRouter } from './modules/reports/reports.router';
import { webhookRouter } from './modules/webhooks/webhook.router';
import { widgetRouter } from './modules/widget/widget.router';

function mountRouter(app: express.Application, mountPath: string, router: Router): void {
  app.use(mountPath, router);

  const basePath = normalizeBasePath(config.APP_BASE_PATH);
  if (basePath) {
    app.use(`${basePath}${mountPath === '/' ? '' : mountPath}`, router);
  }
}

function mountRedirect(
  app: express.Application,
  mountPath: string,
  targetPath: string,
  middleware: express.RequestHandler[] = [],
): void {
  const handler: express.RequestHandler = (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    res.redirect(withBasePath(targetPath, config.APP_BASE_PATH) + query);
  };

  app.use(mountPath, ...middleware, handler);

  const basePath = normalizeBasePath(config.APP_BASE_PATH);
  if (basePath) {
    app.use(`${basePath}${mountPath}`, ...middleware, handler);
  }
}

export function createApp(): express.Application {
  const app = express();
  const publicDir = path.join(process.cwd(), 'public');
  const basePath = normalizeBasePath(config.APP_BASE_PATH);
  const healthHandler: express.RequestHandler = (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'qris-app',
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };

  // Required in production behind Nginx/Cloudflare so secure session cookies
  // and req.secure work correctly when TLS is terminated before Node.
  app.set('trust proxy', 1);

  app.use(
    express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(publicDir));
  if (basePath) {
    app.use(basePath, express.static(publicDir));
  }

  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layouts/main');

  app.use(createSessionMiddleware());

  app.get('/healthz', healthHandler);
  if (basePath) {
    app.get(`${basePath}/healthz`, healthHandler);
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const sessUser = req.session.user ?? null;
    // Perkaya user utk view/gating dgn isMaster + menuPerms (per-request, TANPA ubah session).
    if (sessUser) {
      let isMaster = false;
      let menuPerms: Record<string, boolean> = {};
      try {
        isMaster = isMasterUser(sessUser);
        menuPerms = getMenuPermsForUser(sessUser);
      } catch (err) {
        logger.error({ err }, 'gagal hitung menuPerms');
      }
      res.locals.user = { ...sessUser, isMaster, menuPerms };
      // Auto-logout backstop (server): sesi GESER 60 menit utk non-master, 8 jam utk master.
      // rolling:true -> jendela geser; kalau tab ditutup lebih lama dari ini, sesi mati sendiri.
      if (req.session.cookie) {
        req.session.cookie.maxAge = isMaster ? 8 * 60 * 60 * 1000 : 60 * 60 * 1000;
      }
    } else {
      res.locals.user = null;
    }
    res.locals.flash = req.session.flash ?? null;
    res.locals.basePath = basePath;
    res.locals.url = (pathname: string) => withBasePath(pathname, basePath);
    res.locals.currentPath = req.originalUrl.split('?')[0];

    if (req.session.flash) {
      delete req.session.flash;
    }

    next();
  });

  // SCOPE GLOBAL (RBAC): set konteks akun-site per-request -> Prisma $use auto-filter query alias-tenant.
  // master / alias "semua site" -> null -> tanpa filter. Lihat src/config/database.ts.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    let ids: string[] | null = null;
    try {
      const site = getSiteScopeForUser(req.session.user ?? null);
      ids = site ? accountIdsForSite(site) : null;
    } catch { ids = null; }
    runWithScope({ scopeAccountIds: ids }, next);
  });

  mountRouter(app, '/', authRouter);

  const rootRedirect: express.RequestHandler = (req, res) => {
    if (req.session.user) {
      res.redirect(withBasePath('/dashboard', config.APP_BASE_PATH));
      return;
    }

    res.redirect(withBasePath('/login', config.APP_BASE_PATH));
  };

  app.get('/', rootRedirect);
  if (basePath) {
    app.get(basePath, rootRedirect);
    app.get(`${basePath}/`, rootRedirect);
  }

  mountRouter(app, '/dashboard', Router().use(requireAuth, dashboardRouter));
  mountRedirect(app, '/history', '/dashboard/history', [requireAuth]);
  mountRedirect(app, '/mutations', '/dashboard/mutations/qris', [requireAuth]);
  mountRedirect(app, '/settlement', '/dashboard/settlement', [requireAuth]);
  mountRedirect(app, '/transactions', '/dashboard/transactions', [requireAuth]);
  mountRedirect(app, '/wallet/saldo-utama', '/dashboard/wallet/saldo-utama', [requireAuth]);
  mountRedirect(app, '/wallet/madera', '/dashboard/wallet/madera', [requireAuth]);

  mountRouter(app, '/qris-accounts', Router().use(requireAuth, qrisAccountsRouter));
  mountRouter(app, '/merchant-qr', Router().use(requireAuth, merchantQrRouter));
  mountRouter(app, '/clients', Router().use(requireAuth, clientsRouter));
  mountRouter(app, '/admin-log', Router().use(requireAuth, adminLogRouter));
  mountRedirect(app, '/settings/login-logs', '/dashboard/login-logs', [requireAuth]);
  mountRedirect(app, '/settings/aliases', '/dashboard/aliases', [requireAuth]);

  mountRouter(app, '/reports', reportsRouter);
  mountRouter(app, '/api/v1/reports', reportsRouter);
  mountRouter(app, '/webhook', webhookRouter);
  mountRouter(app, '/widget', widgetRouter);

  if (process.env.NODE_ENV !== 'production') {
    mountRouter(app, '/dev', qrisDevRouter);
  }

  mountRouter(app, '/api/v1/qris', qrisClientRouter);
  mountRouter(app, '/api/v1/qris', Router().use(requireAuth, qrisAdminRouter));

  app.use((req: Request, res: Response) => {
    const requestPath = req.originalUrl.split('?')[0];
    const isApiRequest = requestPath.includes('/api/');

    if (isApiRequest) {
      res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan' });
      return;
    }

    res.status(404).render('error/404', {
      title: 'Halaman Tidak Ditemukan',
      layout: req.session.user ? 'layouts/main' : 'layouts/auth',
    });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.originalUrl }, 'Unhandled error');

    if (req.originalUrl.includes('/api/')) {
      res.status(500).json({ success: false, error: 'Internal server error' });
      return;
    }

    res.status(500).render('error/500', {
      title: 'Server Error',
      layout: req.session.user ? 'layouts/main' : 'layouts/auth',
    });
  });

  return app;
}
