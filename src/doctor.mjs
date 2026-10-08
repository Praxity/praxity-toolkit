import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolInvocation, toolEnvironment, probeProcess, quotePosix, readDeclined } from './tools.mjs';
import { adapters, buildAdapters, skillPresence } from './skills.mjs';
import { loadSchema, validateSchema } from './schema.mjs';

const item = (id, status, message, fix = '') => ({ id, status, message, fix });

export function doctor(context, run = probeProcess) {
  const items = [];
  const work = mkdtempSync(join(tmpdir(), 'praxity-doctor-'));
  const reinstall = `sh ${quotePosix(join(context.root, 'install.sh'))}`;
  const success = result => result.code === 0 && !result.error;
  const failed = (id, result, fix) => item(id, 'failed', result.error ?? (result.stderr.trim() || `Probe failed; process exited ${result.code}`), fix);
  try {
    const node = run({ command: context.node, args: ['--version'], env: context.env });
    items.push(success(node) && node.stdout.trim() === `v${context.pack.runtimes.node.version}`
      ? item('runtime.node', 'ok', node.stdout.trim())
      : item('runtime.node', 'failed', `Expected Node ${context.pack.runtimes.node.version}; ${node.error ?? (node.stdout.trim() || node.stderr.trim())}`, reinstall));
    const typstPath = join(context.root, 'runtimes/typst', context.pack.runtimes.typst.entry[context.state.platform]);
    if (!existsSync(typstPath)) items.push(item('runtime.typst', 'not-installed', 'Typst is absent', reinstall));
    else {
      const source = join(work, 'tiny.typ');
      const pdf = join(work, 'tiny.pdf');
      writeFileSync(source, 'Hello from Praxity.\n');
      const result = run({ command: typstPath, args: ['compile', source, pdf], env: toolEnvironment(context) });
      items.push(success(result) && existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === '%PDF-'
        ? item('runtime.typst', 'ok', 'Tiny document compiled to PDF')
        : failed('runtime.typst', result, reinstall));
    }
    const declined = readDeclined(context);
    for (const tool of context.pack.tools) {
      if (!context.state.installed.includes(tool.id) || !existsSync(join(context.root, 'tools', tool.id, tool.entry))) {
        items.push(item(`tool.${tool.id}`, 'not-installed', tool.archives[context.state.platform]?.reason ?? 'Tool files are absent', reinstall));
        continue;
      }
      if (tool.doctor) {
        const result = run(toolInvocation(context, tool, tool.doctor));
        let owned;
        try {
          if (result.error) throw new Error(result.error);
          owned = JSON.parse(result.stdout);
          if (!Array.isArray(owned.components) || !owned.components.length || ![0, 1].includes(owned.exitCode) || result.code !== owned.exitCode) throw new Error('Invalid tool doctor result or exit code');
          const ids = new Set();
          for (const component of owned.components) {
            if (!['browser', 'java', 'verapdf'].includes(component.id) || ids.has(component.id) || typeof component.usable !== 'boolean' || !['intact', 'damaged', 'absent', 'unmanaged'].includes(component.inventory)) throw new Error('Invalid Check component result');
            ids.add(component.id);
          }
        } catch (error) { items.push(item(`tool.${tool.id}`, 'failed', error.message, `praxity setup ${tool.id}`)); continue; }
        for (const component of owned.components) {
          const fix = `praxity setup ${tool.id} ${component.id}`;
          // An unusable system copy (macOS's /usr/bin/java stub, an old Java) is not the pack's to
          // repair: setup installs a managed one that takes precedence, so it counts as missing.
          const missing = component.source === null && component.inventory === 'absent'
            || component.source === 'system' && component.inventory !== 'damaged';
          const status = component.usable ? 'ok'
            : component.inventory === 'damaged' ? 'failed'
            : missing && declined[tool.id]?.includes(component.id) ? 'declined'
            : missing ? 'not-installed' : 'failed';
          // Without its browser Check audits no HTML at all, and praxity check
          // exits 2. Its setup selector html installs the browser.
          if (component.id === 'browser' && status === 'not-installed') {
            items.push(item(`tool.${tool.id}.${component.id}`, status, 'Browser not installed, so praxity check cannot audit HTML and exits 2. Setup downloads it after asking.', `praxity setup ${tool.id} html`));
            continue;
          }
          items.push(item(`tool.${tool.id}.${component.id}`, status, component.reason ?? (component.usable ? `Found ${component.version ?? 'component'}` : status === 'declined' ? 'Optional download was declined' : 'Component is unavailable'), status === 'ok' ? '' : fix));
        }
      } else {
        let args;
        let expected;
        if (tool.id === 'studio') args = ['inspect', join(context.root, 'fixtures/course'), '--schema', '1'];
        else if (tool.id === 'trace') {
          const input = join(work, 'html');
          mkdirSync(input);
          writeFileSync(join(input, 'index.html'), '<!doctype html><html lang="en"><title>Tiny course</title><main><h1>Welcome</h1><p>Learn one idea.</p></main></html>');
          args = ['report', input, '--out', join(work, 'trace')];
          expected = join(work, 'trace/report.json');
        } else if (tool.id === 'print') {
          const input = join(work, 'print.md');
          writeFileSync(input, '# Tiny document\n\nHello from Praxity.\n');
          expected = join(work, 'print.pdf');
          args = ['render', input, '--output', expected];
        } else if (tool.id === 'import') {
          // Import ships a tiny synthetic SCORM package for exactly this probe.
          const output = join(work, 'import');
          expected = join(output, 'course.yaml');
          args = [join(context.root, 'tools/import/fixtures/smoke/scorm'), '--output', output];
        } else args = ['--help'];
        const result = run(toolInvocation(context, tool, args));
        let ok = success(result);
        if (expected) ok &&= existsSync(expected);
        if (ok && tool.id === 'print') ok &&= readFileSync(expected).subarray(0, 5).toString() === '%PDF-';
        if (ok && ['studio', 'trace', 'import'].includes(tool.id)) {
          try {
            const data = JSON.parse(expected && tool.id === 'trace' ? readFileSync(expected, 'utf8') : result.stdout);
            ok = tool.id === 'studio' ? data.schema === 'praxity-inspect/1' && Array.isArray(data.lessons) && data.lessons.length > 0
              : tool.id === 'import' ? data.ok === true && data.lessons === 1 && data.pages === 1 && data.losses === 0
              : typeof data === 'object' && data !== null;
          } catch { ok = false; }
        }
        items.push(ok ? item(`tool.${tool.id}`, 'ok', 'Functional smoke probe passed') : failed(`tool.${tool.id}`, result, reinstall));
      }
    }
    const toolSkills = context.pack.tools.flatMap(tool => {
      const path = join(context.root, 'tools', tool.id, tool.skillPath ?? 'skill');
      return context.state.installed.includes(tool.id) && existsSync(path) ? [path] : [];
    });
    const generated = buildAdapters({ source: join(context.root, 'skills'), tools: toolSkills, packVersion: context.pack.version });
    for (const [scope, base] of [['user', context.home], ['project', context.cwd]]) for (const host of Object.keys(adapters)) {
      const { current, stale, missing } = skillPresence({ base, host, outputs: generated });
      const fix = `praxity skills install --host ${host} --scope ${scope}`;
      if (!stale.length && !missing.length) items.push(item(`host.${host}.${scope}`, 'ok', `Skill files current in ${adapters[host].skills}; verify invocation in the host`));
      else if (!current.length && !stale.length) items.push(item(`host.${host}.${scope}`, 'not-installed', 'Generated adapter is absent', fix));
      else items.push(item(`host.${host}.${scope}`, 'partial', [missing.length && `Missing skills: ${missing.join(', ')}.`, stale.length && `Changed or out-of-date skills: ${stale.join(', ')}.`].filter(Boolean).join(' '), fix));
    }
    // T3 actions call the launcher by its full path, so a missing PATH entry
    // only affects typed commands. The doctor names the line; it never edits it.
    const onPath = (context.env.PATH ?? '').split(delimiter).some(directory => directory && existsSync(join(directory, 'praxity')));
    items.push(onPath ? item('launcher.path', 'ok', 'praxity is on PATH')
      : item('launcher.path', 'not-installed', 'praxity is not on PATH. T3 course actions still work; in a terminal, type ~/.praxity/bin/praxity or add the PATH line.',
        'Add this line to ~/.zshrc, then open a new terminal and restart T3: export PATH="$HOME/.praxity/bin:$PATH"'));
    const result = { schemaVersion: 1, packVersion: context.pack.version, items, exitCode: items.some(item => item.status === 'failed') ? 1 : 0 };
    const errors = validateSchema(result, loadSchema('doctor'));
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
