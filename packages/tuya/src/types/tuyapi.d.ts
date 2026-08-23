declare module "tuyapi" {
  interface TuyAPIOptions {
    id: string;
    key: string;
    ip: string;
    version?: string;
  }

  interface GetOptions {
    dps?: number | string;
    schema?: boolean;
  }

  class TuyAPI {
    constructor(options: TuyAPIOptions);
    connect(): Promise<boolean>;
    disconnect(): void;
    get(options?: GetOptions): Promise<unknown>;
    on(event: "connected" | "disconnected", handler: () => void): void;
    on(event: "data", handler: (data: { dps: Record<string, unknown> }) => void): void;
    on(event: "error", handler: (err: Error) => void): void;
  }

  export = TuyAPI;
}
