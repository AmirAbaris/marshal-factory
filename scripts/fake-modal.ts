import { ConflictError, NotFoundError, SandboxFilesystemNotFoundError } from "modal";
import type { ModalApi, SandboxHandle, SandboxProcess, SandboxSpec } from "../lib/modal-host";

// A fake Modal for regressions: each sandbox records its execs and files, a per-test handler
// answers execs, and a snapshot is an image that copies the files into the next sandbox.

export type Reply = { code?: number; stdout?: string; stderr?: string; hang?: boolean };
export type Exec = { argv: string[]; params?: { workdir?: string; timeoutMs?: number }; input: string; closed: boolean };

export const fake = {
  answer: (() => ({})) as (sandbox: FakeSandbox, argv: string[]) => Promise<Reply> | Reply,
  created: 0,
  /** Live snapshot images and the files each one holds. */
  images: new Map<string, Map<string, string>>(),
  deletedImages: [] as string[],
  snapshots: [] as { sandboxId: string; imageId: string; ttlMs?: number | null }[],
  /** Everything that happened to any sandbox, in order: execs, snapshots, terminations. */
  ops: [] as string[],
  /** Like Modal, writeText then refuses a path whose directory no `mkdir -p` made and no file is in. */
  parentsRequired: false,
};

export class FakeSandbox implements SandboxHandle {
  execs: Exec[] = [];
  files = new Map<string, string>();
  dirs = new Set<string>();
  terminated = false;
  constructor(
    readonly sandboxId: string,
    readonly spec?: SandboxSpec,
  ) {}
  filesystem = {
    readText: async (path: string) => {
      this.alive();
      const text = this.files.get(path);
      if (text === undefined) throw new SandboxFilesystemNotFoundError(`${path} not found`);
      return text;
    },
    writeText: async (data: string, path: string) => {
      this.alive();
      const parent = path.slice(0, path.lastIndexOf("/"));
      const made = [...this.dirs].some((d) => d === parent || d.startsWith(`${parent}/`)) || [...this.files.keys()].some((f) => f.startsWith(`${parent}/`));
      if (fake.parentsRequired && !made) throw new SandboxFilesystemNotFoundError(`${parent} not found`);
      this.files.set(path, data);
    },
  };
  alive() {
    if (this.terminated) throw new ConflictError(`Sandbox ${this.sandboxId} has already finished`);
  }
  async exec(argv: string[], params?: { workdir?: string; timeoutMs?: number }): Promise<SandboxProcess> {
    this.alive();
    const exec: Exec = { argv, params, input: "", closed: false };
    this.execs.push(exec);
    if (argv[0] === "mkdir" && argv[1] === "-p") for (const d of argv.slice(2)) this.dirs.add(d);
    fake.ops.push(`${this.sandboxId}: ${argv.join(" ")}`);
    const reply = Promise.resolve(fake.answer(this, argv));
    const never = new Promise<never>(() => {});
    return {
      stdin: {
        writeText: async (text) => void (exec.input += text),
        close: async () => void (exec.closed = true),
      },
      stdout: { readText: async () => ((await reply).hang ? never : ((await reply).stdout ?? "")) },
      stderr: { readText: async () => ((await reply).hang ? never : ((await reply).stderr ?? "")) },
      wait: async () => ((await reply).hang ? never : ((await reply).code ?? 0)),
    };
  }
  async terminate() {
    this.terminated = true;
    fake.ops.push(`${this.sandboxId}: terminated`);
  }
  async snapshotFilesystem(params?: { timeoutMs?: number; ttlMs?: number | null }) {
    this.alive();
    const imageId = `im-snap-${fake.snapshots.length + 1}`;
    fake.images.set(imageId, new Map(this.files));
    fake.snapshots.push({ sandboxId: this.sandboxId, imageId, ttlMs: params?.ttlMs });
    fake.ops.push(`${this.sandboxId}: snapshot ${imageId}`);
    return { imageId };
  }
  async tunnels() {
    this.alive();
    return Object.fromEntries((this.spec?.encryptedPorts ?? []).map((port) => [port, { url: `https://${this.sandboxId}-${port}.fake.modal.host` }]));
  }
}

export const sandboxes = new Map<string, FakeSandbox>();

const unknown = (sandboxId: string): SandboxHandle => {
  const missing = async (): Promise<never> => {
    throw new NotFoundError(`Sandbox ${sandboxId} not found`);
  };
  return { sandboxId, exec: missing, filesystem: { readText: missing, writeText: missing }, terminate: missing, snapshotFilesystem: missing, tunnels: missing };
};

export const fakeModal: ModalApi = {
  async create(spec) {
    if (spec.imageId.startsWith("im-snap-") && !fake.images.has(spec.imageId)) throw new NotFoundError(`Image ${spec.imageId} not found`);
    const sandbox = new FakeSandbox(`sb-test-${++fake.created}`, spec);
    for (const [path, text] of fake.images.get(spec.imageId) ?? []) sandbox.files.set(path, text);
    sandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox;
  },
  fromId: async (sandboxId) => sandboxes.get(sandboxId) ?? unknown(sandboxId),
  async list(_appName, tags) {
    return [...sandboxes.values()]
      .filter((s) => !s.terminated && s.spec && Object.entries(tags).every(([k, v]) => s.spec!.tags[k] === v))
      .map((s) => ({ sandboxId: s.sandboxId, tags: s.spec!.tags }));
  },
  async deleteImage(imageId) {
    if (!fake.images.delete(imageId)) throw new NotFoundError(`Image ${imageId} not found`);
    fake.deletedImages.push(imageId);
  },
};
