export type ApiErrorCode =
  | 'GITHUB_AUTH_FAILED'
  | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NETWORK_ERROR'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_TOKEN_INVALID'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'

export interface ApiErrorPayload {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export class ApiError extends Error {
  code: ApiErrorCode
  status: number

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  extraHeaders?: HeadersInit
): Response {
  const payload: ApiErrorPayload = {
    error: {
      code,
      message
    }
  }
  const headers = new Headers(extraHeaders)

  headers.set('Content-Type', 'application/json; charset=utf-8')
  const serialized = JSON.stringify(payload)

  return new Response(serialized, {
    headers,
    status
  })
}

export function fromUnknownError(error: unknown): ApiError {
  const isApiError = error instanceof ApiError

  if (isApiError) {
    return error
  }

  if (error instanceof Error) {
    return new ApiError(500, 'VALIDATION_ERROR', 'Unexpected server error')
  }

  return new ApiError(500, 'VALIDATION_ERROR', 'Unexpected server error')
}
