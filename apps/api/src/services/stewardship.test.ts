import { describe, expect, it } from "vitest";
import { creditLine, creditNames } from "@wfw/shared";

describe("creditLine", () => {
  it("shows an author alone as just the name", () => { expect(creditLine("Sep Kamvar", null)).toBe("Sep Kamvar"); });
  it("tells the author from the steward when both are set", () => { expect(creditLine("Sep Kamvar", "Matthew Kramer")).toBe("Originally created by Sep Kamvar; stewarded by Matthew Kramer"); });
  it("does not repeat a person who is both", () => { expect(creditLine("Erin McKay", "erin mckay")).toBe("Erin McKay"); });
  it("credits a steward where no author is recorded", () => { expect(creditLine(null, "Erin McKay")).toBe("Stewarded by Erin McKay"); });
  it("is nothing when there is nobody", () => { expect(creditLine(" ", null)).toBeNull(); });
});

describe("creditNames", () => {
  it("matches a short given name against the sign-in name", () => { expect(creditNames("Matt Kramer", "Matthew Kramer")).toBe(true); });
  it("finds one author among several", () => { expect(creditNames("Sep Kamvar and Matt Kramer", "Matthew Kramer")).toBe(true); expect(creditNames("Mary Rockett, Katelyn Shore and Erin McKay", "Katelyn Shore")).toBe(true); });
  it("does not match a shared family name alone", () => { expect(creditNames("Sarah Kramer", "Matthew Kramer")).toBe(false); });
  it("does not match on a given name alone", () => { expect(creditNames("Matthew Smith", "Matthew Kramer")).toBe(false); });
  it("needs a full name on both sides", () => { expect(creditNames("Wildflower", "Matthew Kramer")).toBe(false); expect(creditNames("Matt Kramer", "Matt")).toBe(false); expect(creditNames(null, "Matthew Kramer")).toBe(false); });
});
