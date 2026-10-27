"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { installationRepos } from "@/lib/github/installation";
import { reportedHarnesses } from "@/lib/machine";
import { modalEnvConfigured, modalSecretStore } from "@/lib/modal-secrets";
import {
  addRepository as add,
  listAddable,
  rebuildRepoImage as rebuild,
  recordSecretNames,
  retryOnboarding as retry,
  saveRepoSecrets as saveSecrets,
  writeNewRepository,
  writeRepoRequest,
  type SecretsInput,
} from "@/lib/repo-onboarding";
import {
  makeDefaultRepo,
  readRegistry,
  saveRepository as save,
  writeDefaultRepo,
  writeRepository,
  type DefaultRepoInput,
  type RepositoryInput,
} from "@/lib/repositories";
import { syncLabelsFromEnv } from "@/lib/sources/linear";

const user = async () => (await auth.getSession()).data?.user;
const registry = () => readRegistry(db);
const installable = () => installationRepos();
const request = (kind: "onboard_repo" | "rebuild_repo_image", repo: string) => writeRepoRequest(db, kind, repo, new Date());

export async function saveRepository(input: RepositoryInput) {
  return save(
    {
      user,
      registry,
      harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
      save: (choice, by) => writeRepository(db, choice, by, new Date()),
    },
    input,
  );
}

export async function makeDefaultRepository(input: DefaultRepoInput) {
  return makeDefaultRepo({ user, registry, save: (repo, by) => writeDefaultRepo(db, repo, by, new Date()) }, input);
}

export async function addableRepositories() {
  return listAddable({ user, registry, installable });
}

export async function addRepository(input: { repo: string }) {
  return add({ user, registry, installable, create: (repo, by) => writeNewRepository(db, repo, by, new Date()), syncLabels: syncLabelsFromEnv }, input);
}

export async function saveRepositorySecrets(input: SecretsInput) {
  return saveSecrets(
    {
      user,
      registry,
      modalConfigured: () => modalEnvConfigured(),
      upsert: (name, entries) => modalSecretStore().upsert(name, entries),
      recordNames: (repo, names) => recordSecretNames(db, repo, names, new Date()),
    },
    input,
  );
}

export async function retryOnboarding(input: { repo: string }) {
  return retry({ user, registry, request }, input);
}

export async function rebuildRepositoryImage(input: { repo: string }) {
  return rebuild({ user, registry, request }, input);
}
