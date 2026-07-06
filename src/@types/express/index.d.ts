import { Client } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      client?: Client;
    }
  }
}

export {};
