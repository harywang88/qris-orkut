import 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: {
      id: string;
      username: string;
      fullName: string;
      mustChangePassword: boolean;
      permissions: string[];
      isAlias?: boolean;
    };
    flash?: {
      type: 'success' | 'error' | 'info' | 'warning';
      message: string;
    };
  }
}
