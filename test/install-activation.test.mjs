import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installation, archive, replaceInstalled, shell, quote } from './installer-fixture.mjs';

for (const prior of [false, true]) test(`failed activation restores ${prior ? 'the previous pack' : 'no active pack'}`, { skip: process.platform === 'win32' }, t => {
  const f = installation(t, { tools: ['studio'] });
  if (prior) {
    const result = f.install(); assert.equal(result.status, 0, result.stderr);
    f.pack.version = '0.2.0'; f.save(); assert.equal(f.install().status, 0); f.pack.version = '0.3.0';
  }
  const file = join(f.root, 'fake node/bin/node');
  writeFileSync(file, readFileSync(file, 'utf8').replace("echo 'fixture doctor: ok'; exit 0", "echo 'activation doctor failed' >&2; exit 9"));
  f.pack.runtimes.node.archives['darwin-arm64'] = archive(join(f.root, 'fake node'), join(f.root, 'broken node.tar.gz'));
  f.save();
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Activation failed; rolled back/);
  if (prior) assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.2.0\n0.1.0\n');
  else {
    assert.equal(existsSync(join(f.toolkit, 'active')), false);
    assert.equal(existsSync(join(f.home, '.praxity/bin/praxity')), false);
    assert.equal(existsSync(join(f.toolkit, '.launcher-sha256')), false);
  }
});

for (const signal of ['INT', 'TERM', 'KILL']) for (const prior of [false, true]) test(`interrupted doctor ${signal}, prior=${prior}, recovers before retry`, { skip: process.platform === 'win32' }, t => {
 const f = installation(t, { tools: ['studio'] });
 if (prior) { assert.equal(f.install().status, 0); f.pack.version = '0.2.0'; }
 const runtime = join(f.root, 'fake node/bin/node');
 writeFileSync(runtime, readFileSync(runtime, 'utf8').replace("echo 'fixture doctor: ok'; exit 0", `if [ ! -e '${f.root}/interrupted' ]; then touch '${f.root}/interrupted'; kill -${signal} "$(cat '${f.toolkit}/.install-lock/pid')"; exit 9; fi; echo 'fixture doctor: ok'; exit 0`));
 f.pack.runtimes.node.archives['darwin-arm64'] = archive(join(f.root, 'fake node'), join(f.root, 'interrupted.tar.gz')); f.save();
 const result=f.install(); assert.notEqual(result.status,0);
 if(signal !== 'KILL') { if(prior) assert.equal(readFileSync(join(f.toolkit,'active'),'utf8'),'0.1.0\n\n'); else assert.equal(existsSync(join(f.toolkit,'active')),false); }
 const retry=f.install(); assert.equal(retry.status,0,retry.stdout+retry.stderr);
 assert.equal(readFileSync(join(f.toolkit,'active'),'utf8').split('\n')[0],f.pack.version);
 assert.equal(existsSync(join(f.toolkit,'.activation-pending')),false);
});
test('a failed doctor on the active version rolls back to its previous pack', { skip: process.platform === 'win32' }, t => {
 const f=installation(t,{tools:['studio']}); assert.equal(f.install().status,0); f.pack.version='0.2.0';f.save();assert.equal(f.install().status,0);
 const runtime='runtimes/node/bin/node', path=join(f.toolkit,'0.2.0',runtime);
 replaceInstalled(f,'0.2.0',runtime,readFileSync(path,'utf8').replace("echo 'fixture doctor: ok'; exit 0","echo 'broken doctor' >&2; exit 9"));
 const result=f.install();assert.notEqual(result.status,0);assert.match(result.stderr,/rolled back to pack 0.1.0/);assert.equal(readFileSync(join(f.toolkit,'active'),'utf8'),'0.1.0\n\n');
});

for (const corrupt of [false, true]) test(`bundled content-addressed archive corrupt=${corrupt}`, { skip: process.platform === 'win32' }, t => {
  const f=installation(t,{tools:['studio']});
  const bootstrap=join(f.root,'bundle');mkdirSync(bootstrap);
  for(const path of ['install.sh','scripts','src','schemas','skills','fixtures','package.json']) cpSync(new URL(`../${path}`, import.meta.url),join(bootstrap,path),{recursive:true});
  mkdirSync(join(bootstrap,'archives'));
  const entry=f.pack.tools.find(tool=>tool.id==='studio').archives['darwin-arm64'];
  const bytes=readFileSync(new URL(entry.url));
  writeFileSync(join(bootstrap,'archives',`${entry.sha256}.tar.gz`),corrupt?Buffer.from('corrupt bundle'):bytes);
  entry.url='https://invalid.example/verified-studio.tar.gz';f.save();
  const result=shell(`sh ${quote(join(bootstrap,'install.sh'))} --manifest ${quote(new URL(`file://${f.manifest}`).href)} --platform darwin-arm64`,{env:f.env});
  if(corrupt){assert.notEqual(result.status,0);assert.match(result.stderr,/checksum|SHA-256|transfer failed/i);assert.equal(existsSync(join(f.toolkit,'active')),false);}
  else assert.equal(result.status,0,result.stdout+result.stderr);
});

for (const boundary of ['.activation-pending', 'active']) for (const prior of [false, true]) test(`KILL after ${boundary} publication, prior=${prior}`, { skip: process.platform === 'win32' }, t => {
 const f=installation(t,{tools:['studio']});
 if(prior){assert.equal(f.install().status,0);f.pack.version='0.2.0';f.save();}
 const bin=join(f.root,'crash-bin'),marker=join(f.root,'crashed');mkdirSync(bin);
 const real=shell('command -v mv').stdout.trim();
 writeFileSync(join(bin,'mv'),`#!/bin/sh\n${quote(real)} "$@"\ncode=$?\nfor destination; do :; done\nif [ "$code" = 0 ] && [ "$destination" = ${quote(join(f.toolkit,boundary))} ] && [ ! -e ${quote(marker)} ]; then touch ${quote(marker)}; kill -KILL "$(cat ${quote(join(f.toolkit,'.install-lock/pid'))})"; fi\nexit "$code"\n`,{mode:0o755});
 f.env.PATH=`${bin}:${f.env.PATH}`;
 const interrupted=f.install();assert.notEqual(interrupted.status,0);assert.equal(existsSync(marker),true,interrupted.stderr);
 const retry=f.install();assert.equal(retry.status,0,retry.stdout+retry.stderr);
 assert.equal(readFileSync(join(f.toolkit,'active'),'utf8'),`${f.pack.version}\n${prior?'0.1.0':''}\n`);
 assert.equal(existsSync(join(f.toolkit,'.activation-pending')),false);
});
