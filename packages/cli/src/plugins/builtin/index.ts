import type { DevhostPlugin } from '../api.js';
import { stats } from './stats.js';

/**
 * Plugins shipped with devhost, on unless `plugins.<name>.enabled: false`. Others (disk-cleanup,
 * session-stop) live in their own repositories (bankyadam/devhost-plugin-*) and are installed with
 * `devhost plugin install`.
 */
export const builtinPlugins: DevhostPlugin[] = [stats];
