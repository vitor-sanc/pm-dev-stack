import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createTaskmasterService } from '../taskmaster.service.js';

type ServiceDependencies = Parameters<typeof createTaskmasterService>[0];

function createDependencies(
  homeDirectory: string,
  files: Record<string, string>,
  environment: Record<string, string | undefined> = {},
): ServiceDependencies {
  return {
    getHomeDirectory: () => homeDirectory,
    getEnvironment: () => environment,
    readTextFile: async (filePath) => {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`Missing fake file: ${filePath}`);
      }
      return content;
    },
  };
}

test('detectMcpServer returns a redacted TaskMaster server status', async () => {
  const homeDirectory = path.join(path.sep, 'fake-home');
  const configurationPath = path.join(homeDirectory, '.claude.json');
  const service = createTaskmasterService(createDependencies(homeDirectory, {
    [configurationPath]: JSON.stringify({
      mcpServers: {
        'task-master-ai': {
          command: 'npx',
          args: ['-y', 'task-master-ai'],
          env: { ANTHROPIC_API_KEY: 'secret-value' },
        },
      },
    }),
  }));

  assert.deepEqual(await service.detectMcpServer(), {
    hasMCPServer: true,
    isConfigured: true,
    hasApiKeys: true,
    scope: 'user',
    config: {
      command: 'npx',
      args: ['-y', 'task-master-ai'],
      url: null,
      envVars: ['ANTHROPIC_API_KEY'],
      type: 'stdio',
    },
  });
});

test('detectMcpServer checks the fallback configuration after malformed JSON', async () => {
  const homeDirectory = path.join(path.sep, 'fake-home');
  const primaryConfigurationPath = path.join(homeDirectory, '.claude.json');
  const fallbackConfigurationPath = path.join(homeDirectory, '.claude', 'settings.json');
  const service = createTaskmasterService(createDependencies(homeDirectory, {
    [primaryConfigurationPath]: '{ malformed',
    [fallbackConfigurationPath]: JSON.stringify({
      projects: {
        '/workspace/project': {
          mcpServers: {
            'project-task-master': { url: 'https://taskmaster.example.test/mcp' },
          },
        },
      },
    }),
  }));

  assert.deepEqual(await service.detectMcpServer(), {
    hasMCPServer: true,
    isConfigured: true,
    hasApiKeys: false,
    scope: 'local',
    projectPath: '/workspace/project',
    config: {
      command: null,
      args: [],
      url: 'https://taskmaster.example.test/mcp',
      envVars: [],
      type: 'http',
    },
  });
});

test('detectMcpServer reports when no readable Claude configuration exists', async () => {
  const homeDirectory = path.join(path.sep, 'fake-home');
  const service = createTaskmasterService(createDependencies(homeDirectory, {}));

  assert.deepEqual(await service.detectMcpServer(), {
    hasMCPServer: false,
    reason: 'No Claude configuration file found',
    hasConfig: false,
  });
});

test('detectMcpServer reads the Claude configuration from CLAUDE_CONFIG_DIR when it is set', async () => {
  const homeDirectory = path.join(path.sep, 'fake-home');
  const claudeConfigDirectory = path.join(path.sep, 'profiles', 'work-claude');
  const service = createTaskmasterService(createDependencies(homeDirectory, {
    // A config at the default location must be ignored once the CLI is pointed elsewhere.
    [path.join(homeDirectory, '.claude.json')]: JSON.stringify({ mcpServers: {} }),
    [path.join(claudeConfigDirectory, '.claude.json')]: JSON.stringify({
      mcpServers: {
        'task-master-ai': { command: 'npx', args: ['-y', 'task-master-ai'] },
      },
    }),
  }, { CLAUDE_CONFIG_DIR: claudeConfigDirectory }));

  assert.deepEqual(await service.detectMcpServer(), {
    hasMCPServer: true,
    isConfigured: true,
    hasApiKeys: false,
    scope: 'user',
    config: {
      command: 'npx',
      args: ['-y', 'task-master-ai'],
      url: null,
      envVars: [],
      type: 'stdio',
    },
  });
});
