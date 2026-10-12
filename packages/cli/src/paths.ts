import { fileURLToPath } from 'node:url';

/** Works from both src/ (tests) and dist/ (installed): templates/ sits next to either. */
export const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url));
export const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
