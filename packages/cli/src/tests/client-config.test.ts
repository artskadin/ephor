import { describe, expect, it } from "vitest";
import {
  ClientConfigError,
  clientConfigFrom,
  DEFAULT_API_URL,
} from "../client-config.js";

describe("clientConfigFrom", () => {
  it("needs only the token, and then talks to the daemon on this machine", () => {
    expect(clientConfigFrom({ EPHOR_TOKEN: "secret" })).toEqual({
      apiUrl: DEFAULT_API_URL,
      token: "secret",
    });
  });

  it("refuses to run without a token, and says whose token it wants", () => {
    for (const environment of [{}, { EPHOR_TOKEN: "" }]) {
      expect(() => clientConfigFrom(environment)).toThrow(ClientConfigError);
      expect(() => clientConfigFrom(environment)).toThrow(
        /EPHOR_TOKEN is not set.*ephor serve/,
      );
    }
  });

  it.each([
    ["http://bastion.example:31556/", "http://bastion.example:31556"],
    ["https://bastion.example", "https://bastion.example"],
    ["https://bastion.example/ephor/", "https://bastion.example/ephor"],
  ])(
    "takes the address from EPHOR_API_URL, without a trailing slash: %s",
    (given, expected) => {
      expect(
        clientConfigFrom({ EPHOR_TOKEN: "secret", EPHOR_API_URL: given })
          .apiUrl,
      ).toBe(expected);
    },
  );

  it("reads an empty EPHOR_API_URL as not set", () => {
    expect(
      clientConfigFrom({ EPHOR_TOKEN: "secret", EPHOR_API_URL: "" }).apiUrl,
    ).toBe(DEFAULT_API_URL);
  });

  it.each([
    ["bastion", /EPHOR_API_URL is not a URL/],
    ["ftp://bastion.example", /EPHOR_API_URL must start with http/],
    ["http://user:secret@bastion.example", /must not carry credentials/],
    ["http://bastion.example/?x=1", /without a query or fragment/],
    ["http://bastion.example/#state", /without a query or fragment/],
  ])("refuses %s, naming the variable", (given, message) => {
    expect(() =>
      clientConfigFrom({ EPHOR_TOKEN: "secret", EPHOR_API_URL: given }),
    ).toThrow(ClientConfigError);
    expect(() =>
      clientConfigFrom({ EPHOR_TOKEN: "secret", EPHOR_API_URL: given }),
    ).toThrow(message);
  });
});
