import { env } from 'cloudflare:workers';
import { createHistory } from '../server/history.ts';

export function getHistory() {
  return createHistory(env.DB, env.FILES);
}
