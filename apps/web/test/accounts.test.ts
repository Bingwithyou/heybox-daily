import test from "node:test";
import assert from "node:assert/strict";
import { deviceSessions } from "../src/server/accounts.ts";

test("device account discovery excludes expired sessions, deduplicates tokens and clears invalid cookies", async () => {
  const cleared: string[] = [];
  let requested: string[] = [];
  const context = {
    headers: new Headers({
      cookie:
        "session=valid; session_multi-live=valid; session_multi-expired=old; session_multi-forged=bad; unrelated=ignored",
    }),
    context: {
      secret: "fixture-secret",
      authCookies: { sessionToken: { name: "session", attributes: { httpOnly: true, path: "/" } } },
      internalAdapter: {
        findSessions: async (tokens: string[]) => {
          requested = tokens;
          return [
            {
              user: { id: "heybox:1" },
              session: { token: "valid", expiresAt: new Date(Date.now() + 60_000) },
            },
            { user: { id: "heybox:2" }, session: { token: "old", expiresAt: new Date(0) } },
          ];
        },
      },
    },
    getSignedCookie: async (name: string) =>
      name.includes("forged") ? false : name.includes("expired") ? "old" : "valid",
    setCookie: (name: string, value: string, options: { maxAge: number; httpOnly: boolean }) => {
      assert.equal(value, "");
      assert.equal(options.maxAge, 0);
      assert.equal(options.httpOnly, true);
      cleared.push(name);
    },
  } as unknown as Parameters<typeof deviceSessions>[0];
  const sessions = await deviceSessions(context);
  assert.deepEqual(
    sessions.map((item) => item.user.id),
    ["heybox:1"],
  );
  assert.deepEqual(requested, ["valid", "old"]);
  assert.deepEqual(cleared.toSorted(), ["session_multi-expired", "session_multi-forged"]);
});
