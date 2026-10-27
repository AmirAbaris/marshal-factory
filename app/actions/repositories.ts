"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { reportedHarnesses } from "@/lib/machine";
import {
  makeDefaultRepo,
  readRegistry,
  saveRepository as save,
  writeDefaultRepo,
  writeRepository,
  type DefaultRepoInput,
  type RepositoryInput,
} from "@/lib/repositories";

const user = async () => (await auth.getSession()).data?.user;
const registry = () => readRegistry(db);

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
