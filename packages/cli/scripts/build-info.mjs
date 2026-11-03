// Records the git commit the CLI is built from in build-info.json (read by `devhost version`).
// Without git (a source tarball) it writes nothing, and the version simply omits the commit.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build-info.json');
try {
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  writeFileSync(out, `${JSON.stringify({ commit })}\n`);
} catch {
  rmSync(out, { force: true });
}
