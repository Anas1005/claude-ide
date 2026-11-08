// The one place where remote paths are interpreted. Local paths never pass through here, and remote paths never
// reach Node's local `path` default: the semantics follow the platform the remote host reports.
// API v5: any path on the remote host. Absolute paths are taken as given, relative ones resolve against the
// workspace root, and "~" is the remote user's home directory. The remote extension canonicalizes (symbolic links)
// and applies its checks on its side; the OS user's permissions are the boundary.
import * as path from 'path';

/** Path rules of the remote host (`process.platform` reported by the remote extension host). */
export function remotePathApi(remotePlatform: string): path.PlatformPath {
  return remotePlatform === 'win32' ? path.win32 : path.posix;
}

export type RemotePathResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Converts a path from Claude into an absolute, normalized remote path: absolute as given, relative to `base` (the
 * workspace root), "~" or "~/…" under `home` when known.
 */
export function toRemotePath(input: string | undefined, base: string, remotePlatform: string, home?: string): RemotePathResult {
  const p = remotePathApi(remotePlatform);
  const raw = (input ?? '').trim();
  if (raw.includes('\0')) return { ok: false, message: 'Path contains a NUL character.' };
  if (raw === '' || raw === '.') return { ok: true, path: p.normalize(base) };
  if (raw === '~' || raw.startsWith('~/')) {
    if (!home) return { ok: false, message: `The remote home directory is not known; use an absolute path instead of ${raw}.` };
    return { ok: true, path: trim(p, p.join(home, raw.slice(1))) };
  }
  return { ok: true, path: trim(p, p.isAbsolute(raw) ? p.normalize(raw) : p.join(base, raw)) };
}

/** Without a trailing separator (except the root itself). */
function trim(p: path.PlatformPath, value: string): string {
  return value.length > p.parse(value).root.length ? value.replace(/[\\/]+$/, '') : value;
}

/** A path from the remote extension, shown to Claude as an absolute remote path (relative ones from older remotes). */
export function toRemoteAbsolute(value: string, base: string, remotePlatform: string): string {
  const p = remotePathApi(remotePlatform);
  if (p.isAbsolute(value)) return value;
  return value === '.' ? base : p.join(base, ...value.split('/'));
}

/** Is `candidate` the directory `root` or inside it? Both absolute, same platform. */
export function isUnder(candidate: string, root: string, remotePlatform: string): boolean {
  const p = remotePathApi(remotePlatform);
  const rel = p.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}
