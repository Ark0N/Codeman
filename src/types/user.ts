/**
 * @fileoverview Multi-user mode types (opt-in `--multiuser`).
 *
 * Users live in `~/.codeman/users.json` (via `dataPath`, mode 0600). Each record
 * carries a scrypt password hash with its own parameters so hashing cost can be
 * raised later and old records rehashed on next login. `AuthUser` is the
 * request-scoped identity decorated onto Fastify requests; in SINGLE-user mode a
 * synthetic `{ username: 'admin', role: 'admin' }` is used so downstream code has
 * one code path. See `src/user-store.ts` and `docs/multi-user-plan.md`.
 */

export type UserRole = 'admin' | 'user';

/** Per-record scrypt parameters + salt/hash (all hex). */
export interface PasswordHash {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export interface UserRecord {
  /** Canonical lowercase slug; also the user's folder name under USER_SPACES_DIR. */
  username: string;
  role: UserRole;
  password: PasswordHash;
  /** Disabled accounts fail auth closed but keep their space on disk. */
  disabled?: boolean;
  /** Set by an admin reset; gates all API access until the user changes it. */
  mustChangePassword?: boolean;
  /**
   * Permission-mode grant (section 6.3). When false (the default for new users),
   * the user's Claude sessions are forced to `--permission-mode auto`, shell mode
   * and cron `launchCommand` are refused, and other CLIs' bypass flags are dropped.
   */
  canBypassPermissions?: boolean;
  createdAt: number;
  lastLoginAt?: number;
}

/** On-disk shape of `users.json`. */
export interface UsersFile {
  version: 1;
  users: UserRecord[];
}

/** Request-scoped identity (decorated as `req.authUser`). */
export interface AuthUser {
  username: string;
  role: UserRole;
  /**
   * True when a trusted reverse proxy vouched for this request (see
   * src/config/trusted-proxy.ts), so no Codeman password was involved. Absent for
   * cookie, Basic and QR sign-ins.
   */
  viaTrustedProxy?: boolean;
}

/** Admin-facing projection of a user: never carries the password hash. */
export interface PublicUser {
  username: string;
  role: UserRole;
  disabled: boolean;
  mustChangePassword: boolean;
  canBypassPermissions: boolean;
  createdAt: number;
  lastLoginAt?: number;
}
