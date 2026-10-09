import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, repository, examplePack } from './helpers.mjs';

export const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
export const posix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`) : path;
export const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
// curl runs inside fetch subshells. Their parent PID need not be the installer.
export const interruptInstaller = setup => `kill -KILL "$(cat ${quote(posix(join(setup.toolkit, '.install-lock/pid')))})"`;
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
  pack.platforms = ['darwin-arm64'];
  for (const artifact of [...Object.values(pack.runtimes), ...pack.tools]) {
    artifact.archives = { 'darwin-arm64': artifact.archives['darwin-arm64'] };
  }
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
    for (const id of options.tools ?? ['studio', 'trace', 'print']) {
      const tool = pack.tools.find(tool => tool.id === id);
      const payload = join(root, `fake ${id}`);
      mkdirSync(dirname(join(payload, tool.entry)), { recursive: true });
      writeFileSync(join(payload, tool.entry), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
      mkdirSync(dirname(join(payload, tool.notices)), { recursive: true });
      writeFileSync(join(payload, tool.notices), 'Tool legal fixture\n');
      mkdirSync(join(payload, tool.skillPath), { recursive: true });
      const name = id === 'studio' ? 'prax-format' : `fixture-${id}`;
      writeFileSync(join(payload, tool.skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: Write a course.\n---\nTool-owned skill.\n`);
      tool.archives['darwin-arm64'] = archive(payload, join(root, `${id} archive.tar.gz`));
    }
  }
  const manifest = join(root, 'manifest file.json');
  const save = () => writeFileSync(manifest, JSON.stringify(pack, null, 2));
  save();
  const env = { ...process.env, HOME: posix(home), USERPROFILE: home, MSYS_NO_PATHCONV: undefined };
  if (process.platform === 'win32') {
    // Git Bash lacks stock macOS shasum. Emulate its exact invocation locally.
    const bin = join(root, 'fixture-bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'shasum'), '#!/bin/sh\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 99\nshift 2\nexec sha256sum "$@"\n', { mode: 0o755 });
    // Git Bash's ps lacks -o. The in-use test runs on POSIX only, so here no
    // process runs from a test pack.
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\n[ "$*" = "-A -ww -o pid=,args=" ] || exit 99\n', { mode: 0o755 });
    const init = join(root, 'bash-env'); writeFileSync(init, `export PATH=${quote(posix(bin))}:"$PATH"\n`);
    env.BASH_ENV = posix(init);
  }
  const install = (extra = '') => shell(`sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(manifest).href)} --platform darwin-arm64 ${extra}`, { env });
  const action = command => shell(`sh ${quote(posix(join(repository, 'install.sh')))} ${command}`, { env });
  return { root, home, pack, manifest, save, env, install, action, toolkit: join(home, '.praxity/toolkit') };
}

// Kills the installer once, after the first successful wrapped command whose
// arguments meet the shell condition.
export function crashAfter(setup, command, condition) {
  const bin = join(setup.root, 'crash-bin'), marker = join(setup.root, 'crashed');
  mkdirSync(bin);
  const real = shell(`command -v ${command}`).stdout.trim();
  writeFileSync(join(bin, command), `#!/bin/sh\n${quote(real)} "$@"\ncode=$?\nif [ "$code" = 0 ] && [ ! -e ${quote(posix(marker))} ]; then\n${condition}\nfi\nexit "$code"\n`, { mode: 0o755 });
  const init = join(setup.root, 'crash-env');
  writeFileSync(init, (setup.env.BASH_ENV ? readFileSync(setup.env.BASH_ENV.replace(/^\/([a-z])\//, '$1:/'), 'utf8') : '') + `\nexport PATH=${quote(posix(bin))}:"$PATH"\n`);
  setup.env.BASH_ENV = posix(init);
  return marker;
}

// Replaces one file of an installed pack as its installer would have written
// it: the pack's inventory and the install journal agree on the new bytes.
export function replaceInstalled(setup, version, file, bytes) {
  const folder = join(setup.toolkit, version), stateFile = join(folder, 'state.json');
  const digest = data => createHash('sha256').update(data).digest('hex');
  writeFileSync(join(folder, file), bytes);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.files[file] = digest(bytes);
  if (file === 'pack.json') state.manifestSha256 = digest(bytes);
  const stateBytes = JSON.stringify(state, null, 2) + '\n';
  writeFileSync(stateFile, stateBytes);
  appendFileSync(join(setup.toolkit, '.install-ledger.tsv'),
    `F\t${digest(bytes)}\t.praxity/toolkit/${version}/${file}\nF\t${digest(stateBytes)}\t.praxity/toolkit/${version}/state.json\n`);
}
