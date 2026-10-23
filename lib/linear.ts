import { createHash } from "node:crypto";
import { z } from "zod";

const ENDPOINT = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});
export type LinearIssue = z.infer<typeof issueSchema>;

const stateSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });

export class LinearError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** Linear stores a comment under the id we pass, so a replayed create fails instead of duplicating. */
export function commentId(...parts: string[]) {
  const hex = createHash("sha256").update(`marshal-factory\n${parts.join("\n")}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function linearClient(apiKey: string) {
  async function gql<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      data?: unknown;
      errors?: { message: string; extensions?: { userPresentableMessage?: string; code?: string } }[];
    };
    if (json.errors?.length) {
      const [first] = json.errors;
      throw new LinearError(
        first!.extensions?.userPresentableMessage ?? first!.message,
        first!.message.startsWith("conflict on insert") ? "conflict" : first!.extensions?.code,
      );
    }
    return schema.parse(json.data);
  }

  return {
    async team(key: string) {
      const data = await gql(
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } } }`,
        { key },
        z.object({
          teams: z.object({
            nodes: z.array(
              z.object({ id: z.string(), key: z.string(), states: z.object({ nodes: z.array(stateSchema) }) }),
            ),
          }),
        }),
      );
      const team = data.teams.nodes[0];
      if (!team) throw new LinearError(`No Linear team with key ${key}`, undefined);
      return { id: team.id, states: team.states.nodes };
    },

    async readyIssues(teamKey: string, label: string) {
      const data = await gql(
        `query($team: String!, $label: String!) {
          issues(first: 50, filter: {
            team: { key: { eq: $team } },
            labels: { some: { name: { eqIgnoreCase: $label } } },
            state: { type: { eq: "unstarted" } }
          }) {
            nodes { id identifier title url description createdAt state { name type } labels { nodes { name } } }
          }
        }`,
        { team: teamKey, label },
        z.object({ issues: z.object({ nodes: z.array(issueSchema) }) }),
      );
      return data.issues.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async setState(issueId: string, stateId: string) {
      await gql(
        `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
        { id: issueId, stateId },
        z.object({ issueUpdate: z.object({ success: z.literal(true) }) }),
      );
    },

    /** Returns false when a comment with this id already exists. */
    async comment(issueId: string, id: string, body: string) {
      try {
        await gql(
          `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          { input: { id, issueId, body } },
          z.object({ commentCreate: z.object({ success: z.literal(true) }) }),
        );
        return true;
      } catch (error) {
        if (error instanceof LinearError && error.code === "conflict") return false;
        throw error;
      }
    },
  };
}
export type LinearClient = ReturnType<typeof linearClient>;
