import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain path arithmetic (no `new URL`), so this also works where a DOM test environment replaces the URL class.
const here = dirname(fileURLToPath(import.meta.url));

/** Works from both src/ (tests) and dist/ (installed): templates/ sits next to either. */
export const templatesDir = join(here, '..', 'templates') + '/';
export const packageJsonPath = join(here, '..', 'package.json');
/** Written by scripts/build-info.mjs at build time (the git commit); absent in a checkout that was never built. */
export const buildInfoPath = join(here, '..', 'build-info.json');
