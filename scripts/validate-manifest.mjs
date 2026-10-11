import { readManifest, validateReleaseManifest } from '../src/manifest.mjs';
try {
  const pack = readManifest(process.argv[2] ?? 'pack.json');
  if (process.argv[3] === '--release') {
    const errors = validateReleaseManifest(pack);
    if (errors.length) throw new Error(`Pack is not ready to release:\n${errors.join('\n')}`);
  }
  console.log(`Pack ${pack.version}: valid`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
