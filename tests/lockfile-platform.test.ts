import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Sharp Linux packages retain their libc filters', () => {
  const lockfile = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ) as { packages: Record<string, { os?: string[]; libc?: string[] }> };
  const sharpLinux = Object.entries(lockfile.packages).filter(
    ([name, entry]) => name.includes('/@img/sharp-') && entry.os?.includes('linux'),
  );

  assert.ok(sharpLinux.length > 0);
  for (const [name, entry] of sharpLinux) {
    const libc = name.includes('-linuxmusl-') ? 'musl' : 'glibc';
    assert.deepEqual(entry.libc, [libc], name);
  }
});
