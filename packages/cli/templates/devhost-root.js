#!/usr/bin/osascript -l JavaScript
// devhost root helper. Installed by `devhost apply` (machine.rootHelper: true) as
// /Library/PrivilegedHelperTools/app.devhost.root, root:wheel 0755, and allowed without a
// password for one user by /etc/sudoers.d/devhost. It runs only the fixed operations below and
// checks each one, so the passwordless rule never gives more than the user already has: every
// LaunchDaemon it installs runs as that user, nothing user-writable is ever run as root.
//
// It is JavaScript for Automation on the system's own /usr/bin/osascript (SIP-protected) on
// purpose: no Node, no Homebrew, no file a user can change takes part in running it.
/* global ObjC, $ */
ObjC.import('Foundation');
ObjC.import('stdlib');

const LAUNCH_DAEMONS = '/Library/LaunchDaemons';
const LABEL = /^com\.devhost\.[A-Za-z0-9._-]+$/;
const ALLOWED_KEYS = ['Label', 'UserName', 'WorkingDirectory', 'ProgramArguments', 'EnvironmentVariables', 'RunAtLoad', 'KeepAlive', 'ThrottleInterval'];
const HOSTNAME_KEYS = ['ComputerName', 'LocalHostName', 'HostName'];
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PMSET_KEYS = ['sleep', 'disksleep', 'autorestart', 'womp'];
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const VOLUME_MOUNT = /^\/Volumes\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const UNLOCK_LABEL = 'com.devhost.storage.unlock';
const KEYCHAIN = '/Library/Keychains/System.keychain';
const PASSPHRASE_SERVICE = 'devhost.workvolume';
const AUTODISKMOUNT = '/Library/Preferences/SystemConfiguration/autodiskmount';

function fail(message) {
  throw new Error(message);
}

function env(name) {
  const v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return v.isNil() ? '' : ObjC.unwrap(v);
}

function exec(cmd, args, input, quiet) {
  const task = $.NSTask.alloc.init;
  task.launchPath = cmd;
  task.arguments = args;
  if (quiet) task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  let pipe = null;
  if (input !== undefined) {
    pipe = $.NSPipe.pipe;
    task.standardInput = pipe;
  }
  task.launch;
  if (pipe) {
    const h = pipe.fileHandleForWriting;
    h.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
    h.closeFile;
  }
  task.waitUntilExit;
  return task.terminationStatus;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`"${value}" is not an APFS volume UUID`);
  return value;
}

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
}

/**
 * The work volume's unlock daemon (spec A7.12): built here from the UUID alone, never taken from a
 * file, because unlike every other devhost service it runs as root. Every 30 s (KeepAlive with
 * ThrottleInterval) it checks the volume and, only when the volume is present but not mounted,
 * pipes the passphrase from the System keychain into diskutil. Nothing user-writable runs.
 */
function unlockDaemon(id) {
  const script =
    'if [ -z "$(/usr/sbin/diskutil info -plist "$0" 2>/dev/null | /usr/bin/plutil -extract MountPoint raw - 2>/dev/null)" ] && /usr/sbin/diskutil info "$0" >/dev/null 2>&1; then ' +
    `/usr/bin/security find-generic-password -s ${PASSPHRASE_SERVICE} -a devhost -w ${KEYCHAIN} | /usr/bin/tr -d '\\n' | /usr/sbin/diskutil apfs unlockVolume "$0" -stdinpassphrase >/dev/null 2>&1; fi; exit 0`;
  const plist = $.NSDictionary.dictionaryWithDictionary({
    Label: UNLOCK_LABEL,
    ProgramArguments: ['/bin/sh', '-c', script, uuid(id)],
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
  });
  const path = plistPath(UNLOCK_LABEL);
  exec('/bin/launchctl', ['bootout', `system/${UNLOCK_LABEL}`]);
  if (!plist.writeToFileAtomically(path, true)) fail(`cannot write ${path}`);
  exec('/usr/sbin/chown', ['root:wheel', path]);
  exec('/bin/chmod', ['644', path]);
  return exec('/bin/launchctl', ['bootstrap', 'system', path]);
}

/** The passphrase, from stdin only, into the System keychain (spec A7.12): never in an argument. */
function setPassphrase() {
  const pass = readStdin().replace(/\r?\n$/, '');
  if (pass === '' || /[\r\n]/.test(pass)) fail('the passphrase is one non-empty line on stdin');
  const quoted = pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return exec('/usr/bin/security', ['-i'], `add-generic-password -U -a devhost -s ${PASSPHRASE_SERVICE} -l "devhost work volume" -w "${quoted}" ${KEYCHAIN}\n`, true);
}

function label(value) {
  if (typeof value !== 'string' || !LABEL.test(value)) fail(`"${value}" is not a devhost service label`);
  return value;
}

const plistPath = (l) => `${LAUNCH_DAEMONS}/${label(l)}.plist`;

/** A plist devhost may install: the service runs as `user`, with nothing launchd would do as root on its behalf. */
function checkPlist(p, expectedLabel, user, home) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) fail('the plist is not a dictionary');
  for (const k of Object.keys(p)) {
    // StandardOutPath and the like are opened by launchd as root: a symlink in a user-writable
    // directory would let the service's output land in any file.
    if (!ALLOWED_KEYS.includes(k)) fail(`key ${k} is not allowed`);
  }
  if (p.Label !== expectedLabel) fail(`Label must be ${expectedLabel}`);
  if (!user || user === 'root' || p.UserName !== user) fail(`UserName must be ${user}`);
  if (!Array.isArray(p.ProgramArguments) || p.ProgramArguments.length === 0 || !p.ProgramArguments.every((s) => typeof s === 'string')) fail('ProgramArguments must be a list of strings');
  if (p.EnvironmentVariables !== undefined) {
    const e = p.EnvironmentVariables;
    if (e === null || typeof e !== 'object' || Array.isArray(e) || !Object.values(e).every((v) => typeof v === 'string')) fail('EnvironmentVariables must map names to strings');
  }
  for (const k of ['RunAtLoad', 'KeepAlive']) if (p[k] !== undefined && typeof p[k] !== 'boolean') fail(`${k} must be true or false`);
  if (p.ThrottleInterval !== undefined && !Number.isInteger(p.ThrottleInterval)) fail('ThrottleInterval must be an integer');
  if (p.WorkingDirectory !== undefined) {
    const w = p.WorkingDirectory;
    if (typeof w !== 'string' || !(w === home || w.startsWith(`${home}/`)) || w.split('/').includes('..')) fail(`WorkingDirectory must be inside ${home}`);
  }
}

function readPlist(path) {
  const data = $.NSData.dataWithContentsOfFile(path);
  if (data.isNil()) fail(`cannot read ${path}`);
  const plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
  if (plist.isNil()) fail(`${path} is not a property list`);
  return { data, value: ObjC.deepUnwrap(plist) };
}

function caller() {
  const user = env('SUDO_USER');
  if (!user || user === 'root') fail('run through sudo by the devhost user');
  const home = ObjC.unwrap($.NSHomeDirectoryForUser(user));
  if (!home) fail(`no home directory for ${user}`);
  return { user, home };
}

function install(l, staged) {
  const { user, home } = caller();
  // Read once, check what was read, install exactly those bytes: the staged file can change
  // under us, the copy cannot.
  const { data, value } = readPlist(staged);
  checkPlist(value, label(l), user, home);
  const tmp = `${ObjC.unwrap($.NSTemporaryDirectory())}devhost-${l}-${Date.now()}.plist`;
  if (!data.writeToFileAtomically(tmp, true)) fail('cannot write a temporary copy');
  const code = exec('/usr/bin/install', ['-m', '644', '-o', 'root', '-g', 'wheel', tmp, plistPath(l)]);
  $.NSFileManager.defaultManager.removeItemAtPathError(tmp, null);
  return code;
}

/** Only an installed devhost plist that still passes the checks is ever loaded. */
function bootstrap(l) {
  const { user, home } = caller();
  checkPlist(readPlist(plistPath(l)).value, l, user, home);
  return exec('/bin/launchctl', ['bootstrap', 'system', plistPath(l)]);
}

function main(argv) {
  const [op, ...a] = argv;
  switch (op) {
    case 'check': {
      // check <plist> <label> <user> <home>: the plist rules alone, no side effects (tests, `devhost doctor`).
      checkPlist(readPlist(a[0]).value, label(a[1]), a[2], a[3]);
      return 0;
    }
    case 'install':
      return install(a[0], a[1]);
    case 'bootstrap':
      return bootstrap(a[0]);
    case 'bootout':
      return exec('/bin/launchctl', ['bootout', `system/${label(a[0])}`]);
    case 'kickstart':
      if (a[1] !== undefined && a[1] !== '-k') fail('kickstart takes only -k');
      return exec('/bin/launchctl', ['kickstart', ...(a[1] ? ['-k'] : []), `system/${label(a[0])}`]);
    case 'remove':
      return exec('/bin/rm', ['-f', plistPath(a[0])]);
    case 'hostname':
      if (!HOSTNAME_KEYS.includes(a[0]) || !HOSTNAME.test(a[1] || '')) fail('hostname takes ComputerName, LocalHostName or HostName and a host name');
      return exec('/usr/sbin/scutil', ['--set', a[0], a[1]]);
    case 'pmset': {
      if (a.length === 0 || a.length % 2 !== 0) fail('pmset takes setting/value pairs');
      for (let i = 0; i < a.length; i += 2) {
        if (!PMSET_KEYS.includes(a[i]) || !/^\d{1,4}$/.test(a[i + 1])) fail(`pmset ${a[i]} ${a[i + 1]} is not allowed`);
      }
      return exec('/usr/bin/pmset', ['-a', ...a]);
    }
    case 'remote-login':
      return exec('/usr/sbin/systemsetup', ['-setremotelogin', 'on']);
    // The work volume (spec A7.12).
    case 'enable-ownership':
      return exec('/usr/sbin/diskutil', ['enableOwnership', uuid(a[0])]);
    case 'spotlight-off':
      if (!VOLUME_MOUNT.test(a[0] || '')) fail('spotlight-off takes a /Volumes/<name> mount point');
      return exec('/usr/bin/mdutil', ['-i', 'off', a[0]]);
    case 'automount-without-login':
      return exec('/usr/bin/defaults', ['write', AUTODISKMOUNT, 'AutomountDisksWithoutUserLogin', '-bool', 'true']);
    case 'unlock-daemon':
      return unlockDaemon(a[0]);
    case 'unlock-daemon-remove':
      exec('/bin/launchctl', ['bootout', `system/${UNLOCK_LABEL}`]);
      return exec('/bin/rm', ['-f', plistPath(UNLOCK_LABEL)]);
    case 'set-passphrase':
      return setPassphrase();
    case 'remove-passphrase':
      return exec('/usr/bin/security', ['delete-generic-password', '-s', PASSPHRASE_SERVICE, '-a', 'devhost', KEYCHAIN]);
    default:
      fail(`unknown operation "${op}"`);
  }
}

// JXA's entry point. Errors (fail) go to stderr with exit 1; the operation's exit code otherwise.
function run(argv) {
  $.exit(main(argv));
}
