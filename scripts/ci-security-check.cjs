const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const forbiddenTracked = [
  /^\.env(?:\.|$)/,
  /^\.dev\.vars(?:\.|$)/,
  /\.sqlite(?:-shm|-wal)?$/,
  /\.(?:pfx|p12|pem|key)$/,
  /(?:^|\/)secrets\.json$/,
  /(?:^|\/)e2e-login.*\.json$/,
  /(?:^|\/)\.pair-session\.json$/,
  /(?:^|\/)\.wrangler-secret-input$/,
];
const secretPatterns = [
  /TELEGRAM_BOT_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}['\"]/i,
  /CLOUDFLARE_API_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{30,}['\"]/i,
  /TELEGRAM_(?:USER_)?SESSION\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_+=\/-]{40,}['\"]/i,
];
const tracked = cp.execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const badFiles = tracked.filter(f => forbiddenTracked.some(r => r.test(f.replace(/\\/g, '/'))));
if (badFiles.length) {
  console.error('Forbidden tracked sensitive files:\n' + badFiles.join('\n'));
  process.exit(1);
}
let leaks = [];
for (const file of tracked) {
  const full = path.resolve(file);
  if (!fs.existsSync(full) || fs.statSync(full).size > 2 * 1024 * 1024) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const re of secretPatterns) if (re.test(text)) leaks.push(`${file}: ${re}`);
}
if (leaks.length) {
  console.error(`Possible committed secret material detected in ${leaks.length} tracked-file match(es); values are intentionally not printed.`);
  process.exit(1);
}

const historyNames = cp.execFileSync('git', ['log', '--all', '--name-only', '--pretty=format:'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
const historicalPaths = [...new Set(historyNames.split(/\r?\n/).filter(Boolean))];
const badHistoryFiles = historicalPaths.filter(f => forbiddenTracked.some(r => r.test(f.replace(/\\/g, '/'))));
if (badHistoryFiles.length) {
  console.error(`Forbidden sensitive-shaped filename detected in Git history (${badHistoryFiles.length} path(s)); names are intentionally not printed.`);
  process.exit(1);
}

const historyPatch = cp.execFileSync('git', ['log', '-p', '--all', '--no-ext-diff', '--pretty=format:'], {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
if (secretPatterns.some(re => re.test(historyPatch))) {
  console.error('Secret-shaped material detected in Git history; matched values are intentionally not printed.');
  process.exit(1);
}

console.log(`Security check PASS (${tracked.length} tracked files scanned; ${historicalPaths.length} historical paths checked; Git history secret-shape scan clean)`);
