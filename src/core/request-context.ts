import { AsyncLocalStorage } from 'async_hooks';

// Konteks per-request untuk RBAC SITE-SCOPE global (alias-tenant). Diisi middleware saat request masuk
// (src/app.ts), dibaca Prisma $use (src/config/database.ts) untuk auto-filter query baca alias.
// null = master / alias "semua site" / worker (tanpa request) -> TANPA filter (no-op).
export interface RequestScope {
  scopeAccountIds: string[] | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runWithScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function getScopeAccountIdsFromContext(): string[] | null {
  const s = storage.getStore();
  return s ? s.scopeAccountIds : null;
}
