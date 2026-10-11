import { describe, expect, it } from "vitest";
import { isSessionClaimConflict } from "./store";

describe("isSessionClaimConflict", () => {
  it("recognises the duplicate claim a racing run gets", () => {
    const e = Object.assign(new Error('duplicate key value violates unique constraint "st_sessions_pkey"'), {
      code: "23505",
      constraint: "st_sessions_pkey",
    });
    expect(isSessionClaimConflict(e)).toBe(true);
  });

  it("does not swallow other failures, including the cancelled-pick guard", () => {
    expect(isSessionClaimConflict(new Error("invalid input syntax for type integer: \"pick X is cancelled\""))).toBe(false);
    expect(isSessionClaimConflict(Object.assign(new Error("dup"), { code: "23505", constraint: "st_picks_pkey" }))).toBe(false);
    expect(isSessionClaimConflict("boom")).toBe(false);
  });
});
