import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('..', import.meta.url));
export const realPack = () => JSON.parse(readFileSync(join(repository, 'pack.json'), 'utf8'));
export function examplePack() {
  const pack = realPack();
  // Tests choose which tools to publish, independently of release availability.
  for (const tool of pack.tools) {
    for (const platform of Object.keys(tool.archives)) {
      tool.archives[platform] = { status: 'unpublished', reason: 'Not published in this test fixture.' };
    }
  }
  return pack;
}
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'praxity toolkit '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home); mkdirSync(cwd);
  for (const directory of ['skills', 'fixtures']) cpSync(join(repository, directory), join(root, directory), { recursive: true });
  const pack = examplePack();
  const state = { owner: 'praxity-toolkit', installed: [], platform: 'darwin-arm64' };
  const context = { root, home, cwd, pack, state, node: process.execPath, env: process.env };
  return { ...context, context };
}
export function fakeTool(context, id, body = '') {
  const tool = context.pack.tools.find(tool => tool.id === id);
  tool.entry = 'cli.mjs';
  mkdirSync(join(context.root, 'tools', id), { recursive: true });
  writeFileSync(join(context.root, 'tools', id, tool.entry), body);
  context.state.installed.push(id);
  return tool;
}
