export declare const PRODUCTION_APP_URL: string;
export declare const q: (value: unknown) => string;
export declare function appUrlFor(target: "--local" | "--remote" | null, given: string | undefined): string;
export declare function newUserSql(input: {
  userId: string;
  email: string;
  name: string;
  role: string;
  inviteId: string;
  tokenHash: string;
  expiresAt: string;
}): string;
export declare function reinviteSql(input: {
  email: string;
  inviteId: string;
  tokenHash: string;
  expiresAt: string;
  now: string;
}): string;
