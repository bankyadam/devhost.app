import type { DevhostPlugin } from '../api.js';

/**
 * Plugins shipped with devhost. None at the moment: disk-cleanup and session-stop live in their
 * own repositories (bankyadam/devhost-plugin-*) and are installed with `devhost plugin install`.
 */
export const builtinPlugins: DevhostPlugin[] = [];
