const LOCAL_API_TOKEN_STORAGE_KEY = "sanhuoai_local_api_token";
const LOCAL_API_TOKEN_HEADER = "X-Sanhuoai-Token";

export function getLocalApiToken(): string {
  const fromEnv = String(import.meta.env.VITE_LOCAL_API_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return String(window.localStorage.getItem(LOCAL_API_TOKEN_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function withLocalApiAuth(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit || {});
  const token = getLocalApiToken();
  if (token && !headers.has(LOCAL_API_TOKEN_HEADER)) {
    headers.set(LOCAL_API_TOKEN_HEADER, token);
  }
  return headers;
}

export { LOCAL_API_TOKEN_STORAGE_KEY, LOCAL_API_TOKEN_HEADER };
