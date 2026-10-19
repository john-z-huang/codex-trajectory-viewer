export type JsonRecord = Record<string, unknown>;

export interface AgentMetadata {
  threadId: string | null;
  parentThreadId: string | null;
  sourceParentThreadId: string | null;
  conflict: boolean;
  agentPath: string | null;
  nickname: string | null;
  role: string | null;
  depth: number | null;
  parentSessionId?: string | null;
  parentTitle?: string | null;
}

export interface Session {
  id: string;
  sessionId: string;
  threadId?: string;
  archived: boolean;
  preview: string;
  cwd: string;
  timestamp: string;
  filename: string;
  _path: string;
  _relativePath: string;
  _agent: AgentMetadata | null;
  _guardian: boolean;
  _metadataName: string | undefined;
  _metadataTitle: string | undefined;
  _initialUserMessage: string | undefined;
}

export type SessionSummary = Omit<Session, "_path" | "_relativePath" | "_agent" | "_guardian" | "_metadataName" | "_metadataTitle" | "_initialUserMessage"> & {
  title: string;
  model: unknown;
  tokens_used: unknown;
  source: unknown;
  agent: AgentMetadata | null;
  guardian: boolean;
  updatedAt: unknown;
  projectCwd?: string;
  [key: string]: unknown;
};

export interface SubagentActivity {
  threadId: string;
  agentPath: string | null;
  status: string | null;
}

export interface SubagentLink {
  threadId: string;
  session: Session | null;
  agent: AgentMetadata | null;
  status: string | null;
  reason: string | null;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
