export interface AuthContext {
  userId: string;
  merchantId: string;
  role: 'OWNER' | 'ADMIN' | 'QUOTER';
  canViewCost: boolean;
}

export interface AppBindings {
  Variables: {
    auth: AuthContext;
    requestId: string;
  };
}
