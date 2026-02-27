const host = import.meta.env.VITE_AGENT_HOST ?? "127.0.0.1";
const port = import.meta.env.VITE_AGENT_PORT ?? "8765";

export const API_BASE =
  import.meta.env.VITE_API_BASE ?? `http://${host}:${port}`;

