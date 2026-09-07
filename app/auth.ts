import { headers } from 'next/headers';
import { unauthorized } from 'next/navigation';
import { verifyUser } from '../server/auth.ts';

export async function getUser(requestHeaders?: Headers) {
  return verifyUser(requestHeaders ?? (await headers()));
}

export async function requireUser() {
  const user = await getUser();
  if (!user) unauthorized();
  return user;
}
