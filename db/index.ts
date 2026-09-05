import { env } from 'cloudflare:workers';
import { createHistory } from '../server/history.ts';
import { createKeys } from '../server/api-keys.ts';

export function getKeys() {
  return createKeys(env.DB);
}

export function getHistory() {
  return createHistory(env.DB, env.FILES);
}
