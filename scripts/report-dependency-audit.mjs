import { appendFile, readFile } from 'node:fs/promises';

const reportPath = process.argv[2];
let summary;

try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const counts = report.metadata?.vulnerabilities;
  if (!counts || report.error) throw new Error('The audit did not return vulnerability counts.');
  const total = Number(counts.total) || 0;
  const details = ['critical', 'high', 'moderate', 'low', 'info']
    .map((severity) => `${severity}: ${Number(counts[severity]) || 0}`)
    .join(', ');
  summary = `## Dependency audit\n\n${total} known vulnerabilities (${details}).\n\nThe full JSON report is available in the dependency audit artifact. The audit is reported separately from native compilation; npm run verify continues to enforce it locally.\n`;
  console.log(`Dependency audit: ${total} known vulnerabilities (${details}).`);
  if (total && process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning title=Dependency audit::${total} known vulnerabilities (${details}). See the audit artifact.`);
  }
} catch {
  summary = '## Dependency audit\n\nThe audit report could not be read. Check the audit step and retry `npm run audit:dependencies`.\n';
  console.log('Dependency audit unavailable; inspect the audit step for details.');
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::warning title=Dependency audit unavailable::The audit did not produce a readable report. See the audit step.');
  }
}

if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`);
