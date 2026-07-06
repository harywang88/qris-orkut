import 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: {
      id: string;
      username: string;
      fullName: string;
      mustChangePassword: boolean;
      permissions: string[];
    };
    flash?: {
      type: 'success' | 'error' | 'info' | 'warning';
      message: string;
    };
  }
}
