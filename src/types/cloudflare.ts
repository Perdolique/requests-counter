export interface D1Result {
  error?: string;
  success: boolean;
}

export interface D1AllResult<T> {
  results: T[];
}

export interface D1PreparedStatement {
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>
}
