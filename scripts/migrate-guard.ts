import { migrateRefusal } from "../lib/migrate-guard";

const refusal = migrateRefusal(process.env);
if (refusal) {
  console.error(`Refusing to migrate: ${refusal}.\nOnly \`vercel deploy --prod\` may migrate the production branch.`);
  process.exit(1);
}
