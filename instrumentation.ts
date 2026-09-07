import { initializeStorage } from './db';

export async function register() {
  await initializeStorage();
}
