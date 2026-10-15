import path from 'node:path';
import { open, readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  getClaudeConfigDir,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** A `/rename` in the transcript that is newer than the stored name. */
  transcriptRename?: string;
};

/** How much of a transcript's end is read for its current `custom-title`; Claude Code's own `--resume` list reads the same amount. */
const TITLE_TAIL_BYTES = 64 * 1024;

/**
 * Returns the newest `custom-title` in the last `TITLE_TAIL_BYTES` of a
 * transcript, or undefined when there is none or the file cannot be read.
 *
 * A `/rename` in the CLI and a rename from this app both append a
 * `custom-title` entry, and Claude Code appends the current one again as the
 * session goes on, so a title still in effect sits near the end. Reading only
 * the tail keeps this cheap on every change event of a large, active transcript.
 */
async function readLatestCustomTitle(filePath: string, sessionId: string): Promise<string | undefined> {
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fileHandle = await open(filePath, 'r');
    const { size } = await fileHandle.stat();
    const length = Math.min(size, TITLE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await fileHandle.read(buffer, 0, length, size - length);

    // The first line may start mid-entry; it fails to parse and is skipped.
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"custom-title"')) {
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const title = typeof data.customTitle === 'string' ? normalizeSessionName(data.customTitle, '') : '';
      if (data.type === 'custom-title' && data.sessionId === sessionId && title) {
        return title;
      }
    }
  } catch {
    // A missing or unreadable file leaves the stored name as it is.
  } finally {
    await fileHandle?.close();
  }

  return undefined;
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = getClaudeConfigDir();
  private hasReconciledStoredNames = false;

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const sessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      this.storeTranscriptRename(sessionId, parsed);
      processed += 1;
    }

    if (!this.hasReconciledStoredNames) {
      this.hasReconciledStoredNames = true;
      await this.reconcileStoredNames(new Set(files));
    }

    return processed;
  }

  /**
   * Brings stored names up to date with renames the change watcher never saw:
   * ones made while the app was not running. The scan above skips their
   * transcripts, since it only indexes files created after the last scan. Runs
   * on the first scan of the process; one tail read per session keeps it cheap.
   */
  private async reconcileStoredNames(scannedPaths: Set<string>): Promise<void> {
    for (const session of sessionsDb.getAllSessions()) {
      if (session.provider !== this.provider || !session.jsonl_path || scannedPaths.has(session.jsonl_path)) {
        continue;
      }

      const latestTitle = await readLatestCustomTitle(
        session.jsonl_path,
        session.provider_session_id ?? session.session_id,
      );
      if (latestTitle && latestTitle !== session.custom_name) {
        sessionsDb.updateSessionCustomName(session.session_id, latestTitle);
      }
    }
  }

  /**
   * Stores a rename found in the transcript on the row. `createSession` keeps
   * the name of a row the app created, which is right for the names this
   * indexer derives but not for a `/rename`, the name the user chose last.
   */
  private storeTranscriptRename(sessionId: string, parsed: ParsedSession): void {
    if (parsed.transcriptRename) {
      sessionsDb.updateSessionCustomName(sessionId, parsed.transcriptRename);
    }
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const sessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
    this.storeTranscriptRename(sessionId, parsed);
    return sessionId;
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      // The stored name stands against derived titles, but not against a
      // `/rename` made since: that is the name the user chose last.
      const storedName = normalizeSessionName(existingSessionName, 'Untitled Claude Session');
      const latestTitle = await readLatestCustomTitle(filePath, parsed.sessionId);
      const transcriptRename = latestTitle && latestTitle !== storedName ? latestTitle : undefined;
      return {
        ...parsed,
        sessionName: transcriptRename ?? storedName,
        transcriptRename,
      };
    }

    let sessionName = await this.extractSessionTitle(filePath, parsed.sessionId);
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  /**
   * Returns the best available title for one session from its transcript.
   *
   * Scans forward keeping the last match of each event type, then prefers
   * `custom-title` (a manual `/rename`) over `ai-title` over `last-prompt`.
   * Claude writes `custom-title` immediately before `ai-title`, so a reverse
   * scan that returns its first hit would always lose the manual rename.
   *
   * Returns undefined on a missing or unreadable file so sync can continue.
   */
  private async extractSessionTitle(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      let foundCustomTitle: string | undefined;
      let foundAiTitle: string | undefined;
      let foundLastPrompt: string | undefined;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;

        if (eventSessionId !== sessionId) {
          continue;
        }

        if (eventType === 'custom-title') {
          const title = typeof data.customTitle === 'string' ? data.customTitle : undefined;
          if (title?.trim()) {
            foundCustomTitle = title;
          }
        } else if (eventType === 'ai-title') {
          const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
          if (title?.trim()) {
            foundAiTitle = title;
          }
        } else if (eventType === 'last-prompt') {
          const prompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
          if (prompt?.trim()) {
            foundLastPrompt = prompt;
          }
        }
      }

      return foundCustomTitle || foundAiTitle || foundLastPrompt;
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
