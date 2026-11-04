// devhost plugin: voice. Install: devhost plugin install <this folder or repo> --enable
// Uses only the devhost plugin API (the ctx argument) and Node's own modules.
/**
 * voice: a private voice interface for Claude. The server (server/, Python) runs as a LaunchDaemon on the
 * host: faster-whisper (speech to text) and Piper (text to speech) run locally, Claude runs through
 * `claude -p`. A PWA (web/) talks to it over a WebSocket; `tailscale serve` puts HTTPS (needed for the
 * microphone) on the tailnet only. This plugin installs and manages it and reports its health.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const LABEL = 'com.devhost.voice';
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;

export const defaults = (ctx) => {
    const base = Number(process.env.DEVHOST_PORT_BASE ?? 3000);
    const o = ctx.options ?? {};
    const data = join(ctx.home, '.local/share/devhost/voice');
    return {
        data,
        port: Number(o.port ?? base + 90),
        voice: String(o.voice ?? 'hu_HU-anna-medium'),
        sttModel: String(o.sttModel ?? 'small'),
        language: String(o.language ?? 'hu'),
        cwd: String(o.cwd ?? ctx.home),
        permissionMode: String(o.permissionMode ?? 'default'),
    };
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The LaunchDaemon plist: runs as the operator, listens on localhost only (tailscale serve fronts it). */
export function renderPlist(c, user, nodePath) {
    const args = [join(c.data, 'venv/bin/python'), join(here, 'server/server.py'), '--host', '127.0.0.1', '--port', String(c.port),
        '--cwd', c.cwd, '--voice', join(c.data, 'voices', `${c.voice}.onnx`), '--stt-model', c.sttModel, '--language', c.language,
        '--permission-mode', c.permissionMode];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>UserName</key><string>${esc(user)}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${esc(dirname(nodePath))}</string><key>HOME</key><string>${esc(homedir())}</string></dict>
<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${esc(c.data)}/voice.log</string><key>StandardErrorPath</key><string>${esc(c.data)}/voice.log</string>
</dict></plist>
`;
}

export const voiceUrl = (c) => `http://127.0.0.1:${c.port}`;

async function health(c) {
    try {
        const r = await fetch(`${voiceUrl(c)}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch {
        return false;
    }
}

const python = async (ctx) => {
    for (const p of ['/usr/local/opt/python@3.12/bin/python3.12', '/opt/homebrew/opt/python@3.12/bin/python3.12']) {
        if ((await ctx.exec.query('test', ['-x', p])).code === 0) return p;
    }
    throw new Error('python@3.12 is missing: brew install python@3.12 (newer Pythons lack wheels for the speech libraries)');
};

async function install(ctx) {
    const c = defaults(ctx);
    const py = await python(ctx);
    const venv = join(c.data, 'venv');
    await ctx.exec.exec('mkdir', ['-p', join(c.data, 'voices')]);
    await ctx.exec.exec(py, ['-m', 'venv', venv]);
    await ctx.exec.exec(join(venv, 'bin/pip'), ['install', '-q', '-r', join(here, 'server/requirements.txt')]);
    await ctx.exec.exec(join(venv, 'bin/python'), ['-m', 'piper.download_voices', '--data-dir', join(c.data, 'voices'), c.voice]);
    const tmp = join(c.data, `${LABEL}.plist`);
    await ctx.exec.writeText(tmp, renderPlist(c, ctx.user, ctx.nodePath));
    await ctx.exec.exec('install', ['-m', '644', '-o', 'root', '-g', 'wheel', tmp, PLIST], { sudo: true, reason: 'install the voice LaunchDaemon' });
    await ctx.exec.exec('launchctl', ['bootstrap', 'system', PLIST], { sudo: true, reason: 'start the voice service' });
    await ctx.exec.exec('tailscale', ['serve', '--bg', '--https=443', voiceUrl(c)], { reason: 'HTTPS on the tailnet (the microphone needs it)' });
    return { summary: `voice installed; open https://<host>.<tailnet>.ts.net/ on a device in the tailnet` };
}

export default {
    name: 'voice',
    version: '0.1.0',
    description: 'Talk to Claude by voice and hear the answer (local speech engines, PWA on the tailnet)',
    actions: [
        { id: 'install', title: 'Install the voice service', description: 'Python venv, speech models, LaunchDaemon, tailscale serve', scope: 'host', run: (ctx) => install(ctx) },
        {
            id: 'restart', title: 'Restart the voice service', description: 'launchctl kickstart', scope: 'host',
            async run(ctx) {
                await ctx.exec.exec('launchctl', ['kickstart', '-k', `system/${LABEL}`], { sudo: true, reason: 'restart the voice service' });
                return { summary: 'voice service restarted' };
            },
        },
        {
            id: 'uninstall', title: 'Remove the voice service', description: 'Stops it and removes the LaunchDaemon and tailscale serve; models and venv stay', scope: 'host', destructive: true,
            async run(ctx) {
                await ctx.exec.exec('launchctl', ['bootout', `system/${LABEL}`], { sudo: true, reason: 'stop the voice service' });
                await ctx.exec.exec('rm', ['-f', PLIST], { sudo: true, reason: 'remove the voice LaunchDaemon' });
                await ctx.exec.exec('tailscale', ['serve', '--https=443', 'off'], { reason: 'remove the HTTPS front' });
                return { summary: 'voice service removed (models and venv kept)' };
            },
        },
    ],
    checks: [
        {
            id: 'service',
            async run(ctx) {
                const c = defaults(ctx);
                if ((await ctx.exec.query('test', ['-f', PLIST])).code !== 0) return { status: 'warn', message: 'voice service is not installed', fix: 'devhost plugin run voice install' };
                return (await health(c))
                    ? { status: 'ok', message: `voice service answers on port ${c.port}` }
                    : { status: 'fail', message: `voice service does not answer on port ${c.port}`, fix: `tail ${c.data}/voice.log; devhost plugin run voice restart` };
            },
        },
        {
            id: 'models',
            async run(ctx) {
                const c = defaults(ctx);
                const f = join(c.data, 'voices', `${c.voice}.onnx`);
                return (await ctx.exec.query('test', ['-f', f])).code === 0
                    ? { status: 'ok', message: `voice ${c.voice} present` }
                    : { status: 'warn', message: `voice ${c.voice} missing`, fix: 'devhost plugin run voice install' };
            },
        },
    ],
    widgets: [
        {
            id: 'status', title: 'Voice', refreshSeconds: 30,
            async run(ctx) {
                const c = defaults(ctx);
                const up = await health(c);
                return { key: 'voice', title: 'Voice', status: up ? 'ok' : 'warn', summary: up ? 'running' : 'not running',
                    rows: [{ label: 'Port', value: String(c.port) }, { label: 'Voice', value: c.voice }, { label: 'Speech to text', value: `${c.sttModel} (${c.language})` }] };
            },
        },
    ],
};
