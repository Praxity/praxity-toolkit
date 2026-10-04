import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, repository, examplePack } from './helpers.mjs';

export const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
export const posix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`) : path;
export const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
export function shell(command, options = {}) {
  return spawnSync(bash, ['-c', command], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, ...options });
}
export function archive(directory, output) {
  const result = shell(`tar -czf ${quote(posix(output))} -C ${quote(posix(directory))} .`);
  assert.equal(result.status, 0, result.stderr);
  return { status: 'published', url: pathToFileURL(output).href,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'), format: 'tar.gz', stripComponents: 0 };
}
export function installation(t, options = {}) {
  const { root, home: originalHome } = fixture(t);
  const home = options.homeName ? join(root, options.homeName) : originalHome;
  if (options.homeName) mkdirSync(home);
  const pack = examplePack();
  const runtime = join(root, 'fake node');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  const binary = process.execPath.replaceAll('\\', '/');
  // MSYS does not reliably convert paths containing apostrophes for native
  // Node. The fixture emulates a POSIX Node by converting its filesystem args.
  const nativeArguments = process.platform === 'win32' ? 'for fixture_arg do\n  shift\n  case "$fixture_arg" in /*) fixture_arg=$(cygpath -m "$fixture_arg");; esac\n  set -- "$@" "$fixture_arg"\ndone\n' : '';
  // The fake archive delegates parsing/finalization to the test's real Node.
  // Its doctor output is a fake external CLI, independent of doctor unit tests.
  writeFileSync(join(runtime, 'bin/node'), `#!/bin/sh\nif [ "${'$'}{1:-}" = --version ]; then echo v24.21.0; exit 0; fi\ncase "${'$'}{1:-}" in */src/cli.mjs) if [ "${'$'}{2:-}" = doctor ]; then echo 'fixture doctor: ok'; exit 0; fi;; esac\n${nativeArguments}exec ${quote(binary)} "${'$'}@"\n`, { mode: 0o755 });
  writeFileSync(join(runtime, 'LICENSE'), 'Node fixture licence\n');
  pack.runtimes.node.archives['darwin-arm64'] = archive(runtime, join(root, 'node archive.tar.gz'));
  const typst = join(root, 'fake typst'); mkdirSync(typst);
  writeFileSync(join(typst, 'typst'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(typst, 'LICENSE'), 'Typst fixture licence\n');
  pack.runtimes.typst.archives['darwin-arm64'] = archive(typst, join(root, 'typst archive.tar.gz'));
  if (options.tool !== false) {
    const studio = join(root, 'fake studio'); mkdirSync(studio);
    writeFileSync(join(studio, 'praxity.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(join(studio, 'THIRD-PARTY-NOTICES.md'), 'Tool legal fixture\n');
    mkdirSync(join(studio, 'skill'));
    writeFileSync(join(studio, 'skill/SKILL.md'), '---\nname: prax-format\ndescription: Write a course.\n---\nTool-owned skill.\n');
    pack.tools[0].archives['darwin-arm64'] = archive(studio, join(root, 'studio archive.tar.gz'));
  }
  const manifest = join(root, 'manifest file.json');
  const save = () => writeFileSync(manifest, JSON.stringify(pack, null, 2));
  save();
  const env = { ...process.env, HOME: posix(home), USERPROFILE: home, MSYS_NO_PATHCONV: undefined };
  if (process.platform === 'win32') {
    // Git Bash lacks stock macOS shasum. Emulate its exact invocation locally.
    const bin = join(root, 'fixture-bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'shasum'), '#!/bin/sh\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 99\nshift 2\nexec sha256sum "$@"\n', { mode: 0o755 });
    const init = join(root, 'bash-env'); writeFileSync(init, `export PATH=${quote(posix(bin))}:"$PATH"\n`);
    env.BASH_ENV = posix(init);
  }
  const install = (extra = '') => shell(`sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(manifest).href)} --platform darwin-arm64 ${extra}`, { env });
  const action = command => shell(`sh ${quote(posix(join(repository, 'install.sh')))} ${command}`, { env });
  return { root, home, pack, manifest, save, env, install, action, toolkit: join(home, '.praxity/toolkit') };
}
