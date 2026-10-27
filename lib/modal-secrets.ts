import { ModalClient, NotFoundError } from "modal";
import { forbidInTest } from "./test-mode";

// A repo's Modal secret holds the env values its recipe names. Values travel from the owner
// straight to Modal: they are never stored, logged or put in an intent, and an error that would
// quote one is replaced by one that does not.

export type SecretStore = {
  /** Sets these keys in the named secret, creating it if missing; keys it already holds stay. */
  upsert(name: string, entries: Record<string, string>): Promise<void>;
};

type Request = Parameters<ModalClient["cpClient"]["secretGetOrCreate"]>[0];
/** Modal's OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS; the SDK has no public call that names a secret. */
const CREATE_FAIL_IF_EXISTS = 2 as NonNullable<Request["objectCreationType"]>;

/** Rethrows without any secret value in the message. */
export function scrubbed(error: unknown, values: readonly string[]) {
  let text = error instanceof Error ? error.message : String(error);
  for (const value of values) if (value) text = text.split(value).join("[redacted]");
  return new Error(text);
}

/** A store on a Modal client: the env token on Vercel, ~/.modal.toml on a runner. */
export function modalSecretStore(client = () => new ModalClient()): SecretStore {
  return {
    async upsert(name, entries) {
      forbidInTest("Modal");
      const modal = client();
      const values = Object.values(entries);
      try {
        let secretId: string | undefined;
        try {
          secretId = (await modal.secrets.fromName(name)).secretId;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
        if (secretId) {
          await modal.cpClient.secretUpdate({ secretId, updates: Object.entries(entries).map(([key, value]) => ({ key, value })) });
        } else {
          await modal.cpClient.secretGetOrCreate({ deploymentName: name, environmentName: modal.environmentName(), objectCreationType: CREATE_FAIL_IF_EXISTS, envDict: entries });
        }
      } catch (error) {
        throw scrubbed(error, values);
      } finally {
        modal.close();
      }
    },
  };
}

/** Whether this process can reach Modal with a token from its environment; the panel checks it at request time. */
export const modalEnvConfigured = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET);
