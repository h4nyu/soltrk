declare module "tuyapi" {
  interface TuyAPIOptions {
    id: string;
    key: string;
    // Omit to resolve dynamically via find() - see FindOptions below.
    ip?: string;
    version?: string;
  }

  interface GetOptions {
    dps?: number | string;
    schema?: boolean;
  }

  interface SetOptions {
    dps?: number | string;
    set: unknown;
  }

  interface FindOptions {
    timeout?: number;
    all?: boolean;
  }

  class TuyAPI {
    constructor(options: TuyAPIOptions);
    // Listens for the device's own UDP broadcast (port 6666/6667) to
    // resolve `id`/`ip` when constructed without an `ip` - mutates this
    // instance's internal ip in place, so a following connect() uses it.
    // Requires broadcast packets to actually reach the process (blocked by
    // Docker Desktop's default bridge network - see docker-compose.yml's
    // network_mode: host).
    find(options?: FindOptions): Promise<boolean | Array<{ id: string; ip: string }>>;
    connect(): Promise<boolean>;
    disconnect(): void;
    get(options?: GetOptions): Promise<unknown>;
    set(options: SetOptions): Promise<unknown>;
    on(event: "connected" | "disconnected", handler: () => void): void;
    on(event: "data", handler: (data: { dps: Record<string, unknown> }) => void): void;
    on(event: "error", handler: (err: Error) => void): void;
  }

  export = TuyAPI;
}
