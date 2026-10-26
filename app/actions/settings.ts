"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { reportedHarnesses } from "@/lib/machine";
import {
  saveRepoAutonomy as saveAutonomy,
  saveSettings as save,
  writeRepoAutonomy,
  writeSettings,
  type RepoAutonomyInput,
  type SettingsInput,
} from "@/lib/settings";

const user = async () => (await auth.getSession()).data?.user;

export async function saveSettings(input: SettingsInput) {
  return save(
    {
      user,
      harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
      save: (choice, by) => writeSettings(db, choice, by, new Date()),
    },
    input,
  );
}

export async function saveRepoAutonomy(input: RepoAutonomyInput) {
  return saveAutonomy({ user, save: (choice, by) => writeRepoAutonomy(db, choice, by, new Date()) }, input);
}
