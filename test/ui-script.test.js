import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inlineScriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);

assert.ok(inlineScriptMatch, 'expected to find the inline game script in index.html');

test('inline game script parses without syntax errors', () => {
  new Function(inlineScriptMatch[1]);
});
