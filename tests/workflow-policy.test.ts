import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const check = readFileSync('.github/workflows/check.yml', 'utf8');
const image = readFileSync('.github/workflows/image.yml', 'utf8');

test('checks main-targeting pull requests and remains reusable', () => {
  assert.match(
    check,
    /^on:\n  pull_request:\n    branches: \[main\]\n  workflow_call:\n/m,
  );
  assert.match(image, /^    uses: \.\/\.github\/workflows\/check\.yml$/m);
});
