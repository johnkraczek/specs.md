---
name: commit-changes
description: Commit changes to git after code review completes. Called ONCE PER WORK ITEM for atomic git traceability.
version: 1.0.0
---

<objective>
Commit changes to git after code review completes.
Generate conventional commit messages based on work item context.
Stage only files created/modified during the current work item.
<critical>Called AFTER EACH work item completes (not once per run) for atomic git history.</critical>
</objective>

<triggers>
  - Invoked by run-execute after code review completes (Step 6c)
  - Receives: files_created, files_modified, run_id, work_item_id, intent_id, work_item_title
</triggers>

<degrees_of_freedom>
- **COMMIT_MESSAGE**: LOW — Follow conventional commits, derive from work item
- **STAGING**: LOW — Only stage files tracked in current run
- **ERROR HANDLING**: MEDIUM — Skip commit if git unavailable, log warning
</degrees_of_freedom>

<llm critical="true">
  <mandate>ALWAYS use conventional commit format (type: description)</mandate>
  <mandate>ONLY stage files from files_created and files_modified lists</mandate>
  <mandate>ALWAYS include .specs-fire/state.yaml and work item status files with code commits</mandate>
  <mandate>NEVER commit .specs-fire/runs/ artifacts (auto-generated, can be large)</mandate>
  <mandate>INCLUDE work item ID and run ID in commit body for traceability</mandate>
  <mandate>SKIP commit gracefully if git is not initialized</mandate>
  <mandate>DERIVE commit type from work item (feat/fix/refactor/chore/test/docs)</mandate>
</llm>

<input_context>
  The skill receives from run-execute:

  ```yaml
  files_created:
    - path: src/auth/login.ts
      purpose: Login endpoint handler
    - path: src/auth/login.test.ts
      purpose: Unit tests for login

  files_modified:
    - path: src/routes/index.ts
      changes: Added login route

  run_id: run-001
  work_item_id: login-endpoint
  work_item_title: Implement login endpoint
  intent_id: user-auth
  ```

</input_context>

<flow>
  <step n="1" title="Check Git Availability">
    <action>Check if .git directory exists in project root</action>
    <action>Check if git command is available</action>

    <check if="git not available or not initialized">
      <output>
        Git not initialized or unavailable. Skipping commit.
        Run: git init to enable automatic commits.
      </output>
      <return>
        {
          "success": false,
          "skipped": true,
          "reason": "git_not_initialized"
        }
      </return>
    </check>
  </step>

  <step n="2" title="Filter Files for Commit">
    <action>Combine files_created and files_modified into candidate list</action>
    <action>EXCLUDE any files under .specs-fire/ (those are documentation, not code)</action>
    <action>EXCLUDE any files that don't exist (sanity check)</action>

    <check if="no files to commit after filtering">
      <output>No code changes to commit (only .specs-fire artifacts).</output>
      <return>
        {
          "success": false,
          "skipped": true,
          "reason": "no_code_changes"
        }
      </return>
    </check>
  </step>

  <step n="3" title="Generate Conventional Commit Message">
    <action>Determine commit type based on work item:</action>
    <type_determination>
      <pattern if="work item contains 'new', 'add', 'create'">feat</pattern>
      <pattern if="work item contains 'fix', 'bug', 'repair'">fix</pattern>
      <pattern if="work item contains 'test', 'testing'">test</pattern>
      <pattern if="work item contains 'doc', 'document', 'readme'">docs</pattern>
      <pattern if="work item contains 'refactor', 'cleanup'">refactor</pattern>
      <pattern>chore (fallback)</pattern>
    </type_determination>

    <action>Generate commit subject from work_item_title</action>
    <action>Build commit body with:</action>
    <substep>Work item ID and title</substep>
    <substep>Run ID for traceability</substep>
    <substep>File count summary</substep>
    <substep>Co-Authored-By trailer for FIRE</substep>

    <commit_message_format>
      {type}({scope}): {subject}

      Work Item: {work_item_id} - {work_item_title}
      Run: {run_id}

      {files_count} file(s) changed

      Co-Authored-By: Claude FIRE <noreply@fabriqa.ai>
    </commit_message_format>
  </step>

  <step n="4" title="Stage Files">
    <action>Stage each file using git add:</action>
    <code>git add -- {file_path}</code>

    <check if="git add fails for any file">
      <output>Warning: Failed to stage {file_path}. Continuing...</output>
    </check>

    <action>Verify staged files with git status</action>
  </step>

  <step n="5" title="Create Commit">
    <action>Create commit with generated message:</action>
    <code>git commit -m "{commit_message}"</code>

    <check if="commit fails">
      <check if="error is 'nothing to commit'">
        <output>No changes to commit (files may not have changed).</output>
        <return>
          {
            "success": false,
            "skipped": true,
            "reason": "nothing_to_commit"
          }
        </return>
      </check>

      <check if="error is pre-commit hook failure">
        <output>Pre-commit hook failed. Commit skipped.</output>
        <output>Fix issues and commit manually, or skip hooks with --no-verify</output>
        <return>
          {
            "success": false,
            "skipped": true,
            "reason": "pre_commit_hook_failed"
          }
        </return>
      </check>

      <error>Commit failed with unexpected error.</error>
    </check>

    <action>Get commit hash from output</action>
    <code>git rev-parse --short HEAD</code>
  </step>

  <step n="6" title="Return Result">
    <output>
      Changes committed successfully.
      Commit: {commit_hash}
      Type: {type}
      Files: {count}
    </output>

    <return_to_parent>
      {
        "success": true,
        "committed": true,
        "commit_hash": "{short_hash}",
        "commit_type": "{type}",
        "files_count": {count},
        "run_id": "{run_id}"
      }
    </return_to_parent>
  </step>
</flow>

<output_artifact>
  Creates a git commit containing:
  - Only files from the current run (excluding .specs-fire/)
  - Conventional commit message with run ID reference
  - Co-Authored-By trailer for FIRE attribution
</output_artifact>

<scripts>
  | Script | Purpose | Usage |
  |--------|---------|-------|
  | `scripts/commit-changes.cjs` | Perform git commit with conventional message | `node scripts/commit-changes.cjs <rootPath> <runId> [options]` |

  <script name="commit-changes.cjs">
    ```bash
    node scripts/commit-changes.cjs /project run-001 \
      --files-created='[{"path":"...","purpose":"..."}]' \
      --files-modified='[{"path":"...","changes":"..."}]' \
      --work-item-id=wi-1 \
      --work-item-title="Login endpoint" \
      --intent-id=user-auth
    ```

    <output_format>
      ```json
      {
        "success": true,
        "committed": true,
        "commit_hash": "abc1234",
        "commit_type": "feat",
        "files_count": 3,
        "run_id": "run-001"
      }
      ```
    </output_format>

    <skipped_output>
      ```json
      {
        "success": false,
        "skipped": true,
        "reason": "git_not_initialized"
      }
      ```
    </skipped_output>
  </script>
</scripts>
