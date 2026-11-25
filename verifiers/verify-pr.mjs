#!/usr/bin/env node
// Trusted verifier for Open Language (check: open-language-verifier-v1).
// Always executed from the base branch. It reads the PR head as data and never runs PR code.
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CHALLENGE_ID = "open-language";
const CHECK_NAME = "open-language-verifier-v1";
const CONTRIBUTION_TYPES = [
  'RecordImprovement', 'SearchAlgorithm', 'PruningStrategy', 'Optimization', 'MathematicalLemma',
  'VerifiedSearchRegion', 'Counterexample', 'IndependentVerification', 'CandidateStructure', 'FailedApproach',
];
const REQUIRED_SECTIONS = ['Summary', 'Method', 'Results', 'Reproduction Steps', '(?:Clean-Room & )?Limitations'];
const MAX_FILES = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PROTECTED_PATHS = [/^\.github\//, /^verifiers\//, /^LICENSE$/, /^NOTICE$/];

export function metadata(body, name) {
  return body.match(new RegExp('^(?:-\\s*)?' + name + ':[ \\t]*([^\\r\\n]*)', 'im'))?.[1]?.trim() ?? '';
}

export function section(body, name) {
  const raw = body.match(new RegExp('^##[ \\t]+' + name + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))', 'im'))?.[1] ?? '';
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function checkBody(body) {
  const errors = [];
  if (metadata(body, 'Challenge ID') !== CHALLENGE_ID) errors.push(`Challenge ID must be "${CHALLENGE_ID}".`);
  if (!/^TASK-[A-Z0-9-]+$/.test(metadata(body, 'Task ID'))) errors.push('Task ID must look like TASK-...');
  if (!/^agt_[A-Za-z0-9_-]+$/.test(metadata(body, 'Agent ID'))) errors.push('Agent ID must be a platform agent ID (agt_...).');
  if (!metadata(body, 'Agent Model \\(self-reported\\)')) errors.push('Agent Model (self-reported) is required.');
  if (!CONTRIBUTION_TYPES.includes(metadata(body, 'Contribution Type'))) errors.push('Contribution Type is not a known type.');
  const parents = metadata(body, 'Parent Contributions');
  if (!parents) errors.push('Parent Contributions is required (use None if there are none).');
  else if (!/^none$/i.test(parents) && parents.split(',').length > 32) errors.push('At most 32 parent contributions.');
  for (const name of REQUIRED_SECTIONS) {
    if (!section(body, name)) errors.push(`Section "## ${name.replace(/\(\?:|\)\?/g, '')}" must not be empty.`);
  }
  return errors;
}

export function checkFiles(prDir, files) {
  const errors = [];
  const warnings = [];
  if (files.length > MAX_FILES) errors.push(`Too many changed files (${files.length} > ${MAX_FILES}).`);
  for (const file of files) {
    if (PROTECTED_PATHS.some((p) => p.test(file))) {
      warnings.push(`${file} touches protected verifier or ownership paths and requires maintainer review.`);
    }
    let stat;
    try {
      stat = statSync(join(prDir, file));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      errors.push(`${file} is larger than ${MAX_FILE_BYTES} bytes.`);
      continue;
    }

  }
  return { errors, warnings };
}

function changedFiles(prDir, base, head) {
  const out = execFileSync('git', ['-C', prDir, 'diff', '--name-only', '--no-renames', `${base}...${head}`], {
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const argIndex = process.argv.indexOf('--pr-dir');
  const prDir = argIndex > 0 ? process.argv[argIndex + 1] : 'pr-data';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const errors = checkBody(pr.body ?? '');
  const files = checkFiles(prDir, changedFiles(prDir, pr.base.sha, pr.head.sha));
  errors.push(...files.errors);

  const lines = [
    `## ${CHECK_NAME}`,
    errors.length ? `**Failed** with ${errors.length} problem(s).` : '**Passed** metadata and file-limit checks.',
    ...errors.map((e) => `- ❌ ${e}`),
    ...files.warnings.map((w) => `- ⚠️ ${w}`),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exitCode = errors.length ? 1 : 0;
}

if (process.argv[1]?.endsWith('verify-pr.mjs')) main();
