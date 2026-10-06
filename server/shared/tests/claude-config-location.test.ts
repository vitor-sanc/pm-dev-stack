import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getClaudeConfigDir, getClaudeGlobalConfigPath } from '@/shared/utils.js';

const homeDirectory = path.join(path.sep, 'home', 'someone');

test('getClaudeConfigDir defaults to .claude under the home directory', () => {
  assert.equal(getClaudeConfigDir(homeDirectory, {}), path.join(homeDirectory, '.claude'));
});

test('getClaudeConfigDir honors CLAUDE_CONFIG_DIR like the Claude Code CLI', () => {
  const configured = path.join(path.sep, 'profiles', 'work-claude');

  assert.equal(getClaudeConfigDir(homeDirectory, { CLAUDE_CONFIG_DIR: configured }), configured);
});

test('getClaudeConfigDir ignores a blank CLAUDE_CONFIG_DIR', () => {
  assert.equal(getClaudeConfigDir(homeDirectory, { CLAUDE_CONFIG_DIR: '   ' }), path.join(homeDirectory, '.claude'));
});

test('getClaudeGlobalConfigPath defaults to .claude.json next to .claude, not inside it', () => {
  assert.equal(getClaudeGlobalConfigPath(homeDirectory, {}), path.join(homeDirectory, '.claude.json'));
});

test('getClaudeGlobalConfigPath moves .claude.json inside CLAUDE_CONFIG_DIR when it is set', () => {
  const configured = path.join(path.sep, 'profiles', 'work-claude');

  assert.equal(
    getClaudeGlobalConfigPath(homeDirectory, { CLAUDE_CONFIG_DIR: configured }),
    path.join(configured, '.claude.json'),
  );
});
