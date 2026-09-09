import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
const expected = process.argv[2] || pkg.version;
if (![pkg.version, tauri.version, cargo].every(version => version === expected)) {
  throw new Error(`Version mismatch: expected ${expected}, got ${pkg.version}, ${tauri.version}, ${cargo}`);
}
console.log(`All package versions match ${expected}`);
