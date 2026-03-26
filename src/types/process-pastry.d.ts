declare module "process-pastry" {
  export interface StartServerOptions {
    port: number;
    envPath?: string;
    command?: string[];
    expose?: string[];
    html?: string | unknown;
  }

  export function startServer(options: StartServerOptions): void;
}
