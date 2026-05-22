/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SEZNAM_CLIENT_ID: string;
  readonly VITE_MAPY_API_KEY: string;
  /** Optional — base URL of the community backend (Cloudflare Worker). */
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
