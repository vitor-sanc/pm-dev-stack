import { stat, utimes } from 'node:fs/promises';

import { renameSession as renameClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderRename } from '@/shared/interfaces.js';

type ClaudeRenameDependencies = {
  renameTranscript: typeof renameClaudeSession;
  readFileTimes(filePath: string): Promise<{ atime: Date; mtime: Date }>;
  restoreFileTimes(filePath: string, atime: Date, mtime: Date): Promise<void>;
};

/**
 * Writes a UI rename into the Claude transcript itself.
 *
 * The SDK owns the format: it appends the same `custom-title` entry that `/rename`
 * writes in the CLI, which is what `claude --resume` and every other client read
 * a session's name from. Without this, a title set in the UI would exist only in
 * this app's database.
 */
export class ClaudeRenameProvider implements IProviderRename {
  constructor(
    private readonly dependencies: ClaudeRenameDependencies = {
      renameTranscript: renameClaudeSession,
      readFileTimes: (filePath) => stat(filePath),
      restoreFileTimes: (filePath, atime, mtime) => utimes(filePath, atime, mtime),
    },
  ) {}

  async renameSession(input: {
    providerSessionId: string;
    projectPath: string | null;
    jsonlPath: string | null;
    title: string;
  }): Promise<void> {
    // The session index treats the transcript's modification time as the
    // session's last activity, and un-archives a session whose file got newer.
    // A rename is metadata, not activity, so the original times are put back:
    // otherwise renaming old sessions to tidy the sidebar would float every one
    // of them to the top and revive the archived ones.
    const originalTimes = input.jsonlPath
      ? await this.dependencies.readFileTimes(input.jsonlPath).catch(() => null)
      : null;

    // `dir` narrows the lookup to the session's own project folder; without it
    // the SDK searches every project, which still works but is slower.
    await this.dependencies.renameTranscript(input.providerSessionId, input.title, {
      dir: input.projectPath ?? undefined,
    });

    if (input.jsonlPath && originalTimes) {
      await this.dependencies.restoreFileTimes(input.jsonlPath, originalTimes.atime, originalTimes.mtime);
    }
  }
}
