import { migrateRefusal } from "../lib/migrate-guard";

const refusal = migrateRefusal(process.env);
if (refusal) {
  console.error(`Refusing to migrate: ${refusal}.\nOnly a production build may migrate the production branch.`);
  process.exit(1);
}
