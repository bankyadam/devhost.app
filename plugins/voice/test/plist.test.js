import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults, renderPlist, LABEL } from '../index.js';

const ctx = { home: '/Users/adam', user: 'adam', options: { port: 3090, voice: 'hu_HU-imre-medium' } };

test('defaults take options and keep the port inside the block', () => {
    const c = defaults(ctx);
    assert.equal(c.port, 3090);
    assert.equal(c.voice, 'hu_HU-imre-medium');
    assert.equal(defaults({ ...ctx, options: {} }).port, Number(process.env.DEVHOST_PORT_BASE ?? 3000) + 90);
});

test('plist listens on localhost, runs as the user, and escapes values', () => {
    const p = renderPlist({ ...defaults(ctx), cwd: '/a&b' }, 'adam', '/usr/local/bin/node');
    assert.match(p, new RegExp(`<string>${LABEL}</string>`));
    assert.match(p, /<string>127\.0\.0\.1<\/string>/);
    assert.match(p, /<key>UserName<\/key><string>adam<\/string>/);
    assert.match(p, /\/a&amp;b/);
    assert.doesNotMatch(p, /0\.0\.0\.0/);
});
