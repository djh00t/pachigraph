import { Pool } from 'pg';
import { createKeys } from '../server/api-keys.ts';
import { createHistory } from '../server/history.ts';
import { createObjects, type Objects } from '../server/objects.ts';
import { migrate } from './migrate.ts';

let sharedPool: Pool | undefined;
let sharedObjects: Objects | undefined;
let initialization: Promise<void> | undefined;

function pool() {
  if (!sharedPool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    sharedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 5,
    });
  }
  return sharedPool;
}

function objects() {
  sharedObjects ??= createObjects();
  return sharedObjects;
}

export function getKeys() {
  return createKeys(pool());
}

export function getHistory() {
  return createHistory(pool(), objects());
}

export async function storageStatus(): Promise<void> {
  await pool().query('SELECT 1');
  await objects().check();
}

export function initializeStorage(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await migrate(pool());
      await storageStatus();
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

export async function closeStorage(): Promise<void> {
  initialization = undefined;
  sharedObjects?.close();
  sharedObjects = undefined;
  const currentPool = sharedPool;
  sharedPool = undefined;
  await currentPool?.end();
}
