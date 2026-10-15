/**
 * @fileoverview Admin-managed access grants for shared local workspaces.
 *
 * Grants refer to names in linked-cases.json so an unlink also removes the
 * workspace from a user's effective access without leaving a stale path grant.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dataPath, getDataDir } from './config/instance.js';

export interface SharedWorkspacePolicy {
  restricted: true;
  workspaceNames: string[];
}

type WorkspacePolicies = Record<string, SharedWorkspacePolicy>;

const POLICIES_FILE = dataPath('shared-workspaces.json');
const LINKED_CASES_FILE = dataPath('linked-cases.json');

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readPolicies(): WorkspacePolicies {
  const raw = readJsonObject(POLICIES_FILE);
  const result: WorkspacePolicies = {};
  for (const [username, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.restricted !== true || !Array.isArray(record.workspaceNames)) continue;
    const workspaceNames = [
      ...new Set(record.workspaceNames.filter((name): name is string => typeof name === 'string')),
    ];
    result[normalizeUsername(username)] = { restricted: true, workspaceNames };
  }
  return result;
}

export function getSharedWorkspacePolicy(username: string): SharedWorkspacePolicy | undefined {
  return readPolicies()[normalizeUsername(username)];
}

export function getSharedWorkspaceNames(username: string): string[] {
  return getSharedWorkspacePolicy(username)?.workspaceNames ?? [];
}

export function isWorkspaceRestricted(username: string): boolean {
  return getSharedWorkspacePolicy(username)?.restricted === true;
}

export function getSharedWorkspacePaths(username: string): string[] {
  const names = new Set(getSharedWorkspaceNames(username));
  if (!names.size) return [];
  const linked = readJsonObject(LINKED_CASES_FILE);
  return [...names]
    .map((name) => linked[name])
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

export function readLinkedWorkspacePaths(): Record<string, string> {
  const linked = readJsonObject(LINKED_CASES_FILE);
  return Object.fromEntries(
    Object.entries(linked).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export function writeSharedWorkspacePolicy(username: string, workspaceNames: string[]): void {
  const normalized = normalizeUsername(username);
  const policies = readPolicies();
  policies[normalized] = { restricted: true, workspaceNames: [...new Set(workspaceNames)] };
  writePolicies(policies);
}

export function deleteSharedWorkspacePolicy(username: string): void {
  const normalized = normalizeUsername(username);
  const policies = readPolicies();
  if (!(normalized in policies)) return;
  delete policies[normalized];
  writePolicies(policies);
}

function writePolicies(policies: WorkspacePolicies): void {
  mkdirSync(getDataDir(), { recursive: true });
  const tempFile = `${POLICIES_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify(policies, null, 2), { mode: 0o600 });
    renameSync(tempFile, POLICIES_FILE);
    chmodSync(POLICIES_FILE, 0o600);
  } finally {
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}
