import { describe, expect, it } from "vitest";
import { fixedToken } from "./api.ts";
import { Credentials } from "./credentials.ts";
import { credentialsOf, ServicesSchema } from "./services.ts";

const waypoint = { url: "https://waypoint.example/", urlVar: "WAYPOINT_URL", tokenVar: "WAYPOINT_TOKEN", tokenEnv: "WP", mcp: "/mcp" };
const peek = { url: "https://peek.example", urlByHost: { desktop: "https://peek-desktop.example/" }, urlVar: "PEEK_URL", tokenVar: "PEEK_TOKEN", tokenEnv: "PK" };

describe("a services file", () => {
  it("reads an entry without urlByHost as before, giving every host its url", () => {
    const services = ServicesSchema.parse({ waypoint });
    expect(services).toEqual({ waypoint });
    const known = new Credentials(credentialsOf(services, fixedToken("a"), {}));
    expect(known.addresses(["waypoint"], "https://agency", "desktop")).toEqual({ WAYPOINT_URL: "https://waypoint.example" });
  });

  it("gives a host urlByHost names its own address, and any other host url", () => {
    const known = new Credentials(credentialsOf(ServicesSchema.parse({ waypoint, peek }), fixedToken("a"), {}));
    expect(known.addresses(["peek", "waypoint"], "https://agency", "desktop")).toEqual({ PEEK_URL: "https://peek-desktop.example", WAYPOINT_URL: "https://waypoint.example" });
    expect(known.addresses(["peek"], "https://agency", "laptop")).toEqual({ PEEK_URL: "https://peek.example" });
    expect(known.addresses(["peek"], "https://agency", "constructor")).toEqual({ PEEK_URL: "https://peek.example" });
    expect(known.addresses(["peek"], "https://agency")).toEqual({ PEEK_URL: "https://peek.example" });
  });

  it("refuses a urlByHost address that is not a URL", () => {
    expect(ServicesSchema.safeParse({ peek: { ...peek, urlByHost: { desktop: "nope" } } }).success).toBe(false);
  });
});
