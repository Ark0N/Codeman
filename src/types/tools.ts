/**
 * @fileoverview Tool-related type definitions.
 *
 * Types for tracking Claude's tool invocations in real-time.
 *
 * Key exports:
 * - ActiveBashTool — a live bash command with extracted file paths and status
 * - ActiveBashToolStatus — 'running' | 'completed'
 * - ImageDetectedEvent — screenshot/image file detection trigger for UI popup
 * - AttachmentDetectedEvent — document/image file detection trigger for attachment cards
 *
 * Cross-domain relationships:
 * - ActiveBashTool.sessionId links to SessionState.id (session domain)
 * - ImageDetectedEvent.sessionId links to SessionState.id (session domain)
 *
 * Both types are in-memory only (not persisted). Broadcast via SSE events
 * `subagent:tool_call`, `image:detected`, and `attachment:detected`. Parsed by BashToolParser
 * (`src/bash-tool-parser.ts`).
 */

/**
 * Status of an active Bash tool command.
 */
export type ActiveBashToolStatus = 'running' | 'completed';

/**
 * Represents an active Bash tool command detected in Claude's output.
 * Used to display clickable file paths for file-viewing commands.
 */
export interface ActiveBashTool {
  /** Unique identifier for this tool invocation */
  id: string;
  /** The full command being executed */
  command: string;
  /** Extracted file paths from the command (clickable) */
  filePaths: string[];
  /** Timeout string if specified (e.g., "16m 0s") */
  timeout?: string;
  /** Timestamp when the tool started */
  startedAt: number;
  /** Current status */
  status: ActiveBashToolStatus;
  /** Session ID this tool belongs to */
  sessionId: string;
}

/**
 * Event emitted when a new image file is detected in a session's working directory.
 * Used to trigger automatic image popup display in the web UI.
 */
export interface ImageDetectedEvent {
  /** Codeman session ID where the image was detected */
  sessionId: string;
  /** Full path to the detected image file */
  filePath: string;
  /** Path relative to the session's working directory (for file-raw endpoint) */
  relativePath: string;
  /** Image file name (basename) */
  fileName: string;
  /** Timestamp when the image was detected */
  timestamp: number;
  /** File size in bytes */
  size: number;
}

export type AttachmentDetectedType =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'markdown'
  | 'text';

/**
 * Event emitted when a new previewable attachment file is detected in a session's
 * working directory. Used to render a compact attachment card in the web UI.
 */
export interface AttachmentDetectedEvent {
  /** Codeman session ID where the attachment was detected */
  sessionId: string;
  /** Full path to the detected attachment file */
  filePath: string;
  /** Path relative to the session's working directory (for file-raw/file-preview endpoints) */
  relativePath: string;
  /** Attachment file name (basename) */
  fileName: string;
  /** Lowercase extension without a leading dot */
  extension: string;
  /** Viewer category used by the web UI */
  attachmentType: AttachmentDetectedType;
  /** Timestamp when the attachment was detected */
  timestamp: number;
  /** File size in bytes */
  size: number;
  /** Registered attachment id for explicit live external attachments */
  attachmentId?: string;
  /** Source of the attachment card request */
  source?: 'detected' | 'external';
  /** Raw file route for explicit attachments */
  rawUrl?: string;
  /** Inline preview route for explicit attachments */
  previewUrl?: string;
  /** First-page thumbnail route for card previews */
  thumbnailUrl?: string;
}
