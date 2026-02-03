#!/usr/bin/env node

/**
 * FIRE Commit Changes Script
 *
 * Commits changes to git after code review completes.
 * Generates conventional commit messages based on work item context.
 *
 * Usage:
 *   node scripts/commit-changes.cjs <rootPath> <runId> [options]
 *
 * Options:
 *   --files-created=JSON   - JSON array of {path, purpose}
 *   --files-modified=JSON  - JSON array of {path, changes}
 *   --work-item-id=ID      - Work item ID
 *   --work-item-title=STR  - Work item title
 *   --intent-id=ID         - Intent ID
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =============================================================================
// Error Helper
// =============================================================================

function fireError(message, code, suggestion) {
  const err = new Error(`FIRE Error [${code}]: ${message} ${suggestion}`);
  err.code = code;
  err.suggestion = suggestion;
  return err;
}

// =============================================================================
// Validation
// =============================================================================

function validateInputs(rootPath, runId) {
  if (!rootPath || typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw fireError('rootPath is required.', 'COMMIT_001', 'Provide a valid project root path.');
  }

  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw fireError('runId is required.', 'COMMIT_002', 'Provide the run ID.');
  }

  if (!fs.existsSync(rootPath)) {
    throw fireError(
      `Project root not found: "${rootPath}".`,
      'COMMIT_003',
      'Ensure the path exists and is accessible.'
    );
  }
}

// =============================================================================
// Git Operations
// =============================================================================

/**
 * Check if git is available and repository is initialized.
 */
function checkGitAvailable(rootPath) {
  try {
    // Check if .git directory exists
    const gitDir = path.join(rootPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return { available: false, reason: 'git_not_initialized' };
    }

    // Check if git command works
    execSync('git --version', { cwd: rootPath, stdio: 'ignore' });
    execSync('git rev-parse --git-dir', { cwd: rootPath, stdio: 'ignore' });

    return { available: true };
  } catch (err) {
    return { available: false, reason: 'git_not_available' };
  }
}

/**
 * Get short commit hash of HEAD.
 */
function getShortCommitHash(rootPath) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: rootPath, encoding: 'utf-8' }).trim();
  } catch (err) {
    return null;
  }
}

/**
 * Stage a specific file.
 */
function stageFile(rootPath, filePath) {
  try {
    execSync(`git add -- "${filePath}"`, { cwd: rootPath, stdio: 'ignore' });
    return true;
  } catch (err) {
    console.error(`Warning: Failed to stage ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Create commit with message.
 */
function createCommit(rootPath, message) {
  try {
    // Use --allow-empty so we can distinguish between "no changes" and actual errors
    // We'll check the output to see if anything was actually committed
    const result = execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: rootPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    return { success: true, output: result };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message || '';

    // Check for "nothing to commit" - this means files didn't actually change
    if (stderr.includes('nothing to commit')) {
      return { success: false, reason: 'nothing_to_commit', stderr };
    }

    // Check for pre-commit hook failure
    if (stderr.includes('pre-commit hook')) {
      return { success: false, reason: 'pre_commit_hook_failed', stderr };
    }

    // Unknown error
    return { success: false, reason: 'unknown_error', stderr };
  }
}

// =============================================================================
// Commit Message Generation
// =============================================================================

/**
 * Determine commit type from work item title.
 */
function determineCommitType(workItemTitle) {
  const title = (workItemTitle || '').toLowerCase();

  if (/^(new|add|create|implement|introduce|build)/.test(title)) return 'feat';
  if (/^(fix|repair|resolve|correct|bug|patch)/.test(title)) return 'fix';
  if (/test|testing|spec|coverage/.test(title)) return 'test';
  if (/doc|document|readme|changelog|comment/.test(title)) return 'docs';
  if (/refactor|cleanup|restructure|reorganize/.test(title)) return 'refactor';
  if (/performance|optimize|speed/.test(title)) return 'perf';
  if (/style|format|lint|whitespace/.test(title)) return 'style';

  return 'chore';
}

/**
 * Generate scope from work item ID or intent ID.
 * Extracts a meaningful scope if possible, otherwise returns null.
 */
function generateScope(workItemId, intentId) {
  // Use intent ID as scope if it's descriptive enough
  if (intentId && intentId.length > 0 && intentId !== 'default') {
    // Convert kebab-case or snake_case to lowercase words
    return intentId.replace(/[_-]/g, ' ').replace(/\s+/g, '-').toLowerCase();
  }

  return null;
}

/**
 * Format commit subject from work item title.
 */
function formatSubject(workItemTitle) {
  if (!workItemTitle) return 'Update code';

  // Remove leading type/colons if present
  let subject = workItemTitle
    .replace(/^(feat|fix|test|docs|refactor|perf|style|chore)(\(.+\))?:\s*/i, '')
    .toLowerCase();

  // Capitalize first letter
  subject = subject.charAt(0).toUpperCase() + subject.slice(1);

  // Limit to 72 chars
  if (subject.length > 72) {
    subject = subject.substring(0, 69) + '...';
  }

  return subject;
}

/**
 * Generate conventional commit message.
 */
function generateCommitMessage(workItemId, workItemTitle, intentId, runId, filesCount) {
  const type = determineCommitType(workItemTitle);
  const scope = generateScope(workItemId, intentId);
  const subject = formatSubject(workItemTitle);

  // Build header
  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;

  // Build body
  const body = [
    '',
    `Work Item: ${workItemId} - ${workItemTitle}`,
    `Run: ${runId}`,
    '',
    `${filesCount} file(s) changed`
  ].join('\n');

  return header + body;
}

// =============================================================================
// File Filtering
// =============================================================================

/**
 * Filter files to only those that should be committed.
 * Excludes .specs-fire/ artifacts and non-existent files.
 */
function filterFilesForCommit(rootPath, filesCreated, filesModified) {
  const toCommit = [];

  const processFile = (file, list) => {
    // Skip .specs-fire/ files (documentation artifacts)
    if (file.path.startsWith('.specs-fire/') || file.path.includes('/.specs-fire/')) {
      return false;
    }

    // Skip if file doesn't exist
    const fullPath = path.join(rootPath, file.path);
    if (!fs.existsSync(fullPath)) {
      console.warn(`Warning: File not found, skipping: ${file.path}`);
      return false;
    }

    toCommit.push(file.path);
    return true;
  };

  if (Array.isArray(filesCreated)) {
    filesCreated.forEach(f => processFile(f, 'created'));
  }

  if (Array.isArray(filesModified)) {
    filesModified.forEach(f => processFile(f, 'modified'));
  }

  return toCommit;
}

// =============================================================================
// Main Function
// =============================================================================

function commitChanges(rootPath, runId, params = {}) {
  const {
    filesCreated = [],
    filesModified = [],
    workItemId = 'unknown',
    workItemTitle = 'Code changes',
    intentId = '',
  } = params;

  // Validate inputs
  validateInputs(rootPath, runId);

  // Check git availability
  const gitCheck = checkGitAvailable(rootPath);
  if (!gitCheck.available) {
    return {
      success: false,
      skipped: true,
      reason: gitCheck.reason
    };
  }

  // Filter files for commit
  const filesToCommit = filterFilesForCommit(rootPath, filesCreated, filesModified);

  if (filesToCommit.length === 0) {
    return {
      success: false,
      skipped: true,
      reason: 'no_code_changes'
    };
  }

  // Stage files
  let stagedCount = 0;
  for (const filePath of filesToCommit) {
    if (stageFile(rootPath, filePath)) {
      stagedCount++;
    }
  }

  if (stagedCount === 0) {
    return {
      success: false,
      skipped: true,
      reason: 'failed_to_stage_files'
    };
  }

  // Generate commit message
  const commitMessage = generateCommitMessage(
    workItemId,
    workItemTitle,
    intentId,
    runId,
    stagedCount
  );

  // Create commit
  const commitResult = createCommit(rootPath, commitMessage);

  if (!commitResult.success) {
    return {
      success: false,
      skipped: true,
      reason: commitResult.reason,
      stderr: commitResult.stderr
    };
  }

  // Get commit hash
  const commitHash = getShortCommitHash(rootPath);
  const commitType = determineCommitType(workItemTitle);

  return {
    success: true,
    committed: true,
    commit_hash: commitHash,
    commit_type: commitType,
    files_count: stagedCount,
    run_id: runId
  };
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs(args) {
  const result = {
    rootPath: args[0],
    runId: args[1],
    filesCreated: [],
    filesModified: [],
    workItemId: '',
    workItemTitle: '',
    intentId: '',
  };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--files-created=')) {
      try {
        result.filesCreated = JSON.parse(arg.substring('--files-created='.length));
      } catch (e) {
        console.error('Warning: Could not parse --files-created JSON');
      }
    } else if (arg.startsWith('--files-modified=')) {
      try {
        result.filesModified = JSON.parse(arg.substring('--files-modified='.length));
      } catch (e) {
        console.error('Warning: Could not parse --files-modified JSON');
      }
    } else if (arg.startsWith('--work-item-id=')) {
      result.workItemId = arg.substring('--work-item-id='.length);
    } else if (arg.startsWith('--work-item-title=')) {
      result.workItemTitle = arg.substring('--work-item-title='.length);
    } else if (arg.startsWith('--intent-id=')) {
      result.intentId = arg.substring('--intent-id='.length);
    }
  }

  return result;
}

function printUsage() {
  console.error('Usage:');
  console.error('  node scripts/commit-changes.cjs <rootPath> <runId> [options]');
  console.error('');
  console.error('Arguments:');
  console.error('  rootPath  - Project root directory');
  console.error('  runId     - Run ID (e.g., run-001)');
  console.error('');
  console.error('Options:');
  console.error('  --files-created=JSON   - JSON array of {path, purpose}');
  console.error('  --files-modified=JSON  - JSON array of {path, changes}');
  console.error('  --work-item-id=ID      - Work item ID');
  console.error('  --work-item-title=STR  - Work item title');
  console.error('  --intent-id=ID         - Intent ID');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/commit-changes.cjs /project run-001 \\');
  console.error('    --files-created=\'[{"path":"src/new.ts","purpose":"New feature"}]\' \\');
  console.error('    --files-modified=\'[{"path":"src/old.ts","changes":"Added import"}]\' \\');
  console.error('    --work-item-id=login-endpoint \\');
  console.error('    --work-item-title="Implement login endpoint" \\');
  console.error('    --intent-id=user-auth');
}

// =============================================================================
// CLI Interface
// =============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const params = parseArgs(args);

  try {
    const result = commitChanges(params.rootPath, params.runId, {
      filesCreated: params.filesCreated,
      filesModified: params.filesModified,
      workItemId: params.workItemId,
      workItemTitle: params.workItemTitle,
      intentId: params.intentId,
    });

    console.log(JSON.stringify(result, null, 2));

    // Exit 0 even if skipped (graceful handling)
    // Exit 1 only on actual errors
    if (result.success === false && !result.skipped) {
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { commitChanges, checkGitAvailable, filterFilesForCommit };
