export const TEST_BRANCH_ENV = "FACTORY_TEST_BRANCH_ID";

export const TEST_ENDPOINT_ENV = "FACTORY_TEST_ENDPOINT_ID";

export const endpointOf = (url: string) => new URL(url).hostname.split(".")[0]!.replace(/-pooler$/, "");

export const inTestMode = () => Boolean(process.env[TEST_BRANCH_ENV]);

export function forbidInTest(service: string) {
  if (inTestMode()) throw new Error(`${service} was called during a regression run; give the test a fake`);
}
