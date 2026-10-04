import { readManifest } from '../src/manifest.mjs';
try {
  const pack = readManifest(process.argv[2] ?? 'pack.json');
  console.log(`Pack ${pack.version}: valid`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
