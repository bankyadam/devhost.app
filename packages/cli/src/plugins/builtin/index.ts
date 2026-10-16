import type { DevhostPlugin } from '../api.js';
import { diskCleanup } from './disk-cleanup.js';

/** Plugins shipped with devhost (each in its own module here). */
export const builtinPlugins: DevhostPlugin[] = [diskCleanup];
