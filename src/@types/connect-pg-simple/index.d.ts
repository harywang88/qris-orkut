declare module 'connect-pg-simple' {
  import type session from 'express-session';

  type PgSessionStoreFactory = (sessionModule: typeof session) => new (
    options?: Record<string, unknown>,
  ) => session.Store;

  const connectPgSimple: PgSessionStoreFactory;
  export default connectPgSimple;
}
