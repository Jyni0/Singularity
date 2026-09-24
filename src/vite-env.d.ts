/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** App version from package.json, injected by Vite's `define`. */
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
