/** Clean, coded errors. Every tool surfaces these instead of raw exceptions. */
export type McpErrorCode =
  | 'unknown-session'
  | 'session-dirty'
  | 'folder-project-unsupported'
  | 'path-not-allowed'
  | 'project-load-failed'
  | 'validation-failed'
  | 'post-apply-failed'
  | 'io-error'
  | 'libgd-unavailable'
  | 'catalog-unavailable';

export class McpError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpError';
    this.code = code;
  }
}

export function unknownSession(id: string): McpError {
  return new McpError('unknown-session', `Unknown session: ${id}. Create one with create_project or open one with open_project.`);
}

export function validationFailed(message: string, options?: ErrorOptions): McpError {
  return new McpError('validation-failed', message, options);
}

export function postApplyFailed(message: string, options?: ErrorOptions): McpError {
  return new McpError('post-apply-failed', message, options);
}
