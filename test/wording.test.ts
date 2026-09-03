import { describe, expect, it } from "vitest";
import {
  HIDE_DESTINATION_ENV_VAR,
  hideDestinationFrom,
  neutralize,
  redactWebhookTokens,
  wordingFor,
  wordingFromEnv,
} from "../src/wording.js";

const FORBIDDEN = /discord|webhook/i;
const WEBHOOK = "https://discord.com/api/webhooks/123456789/aBc_dEf-123";

describe("hideDestinationFrom", () => {
  it("is on for 1, true, yes, and on, whatever the case or padding", () => {
    for (const value of ["1", "true", "TRUE", "yes", " on "]) {
      expect(hideDestinationFrom({ [HIDE_DESTINATION_ENV_VAR]: value })).toBe(true);
    }
  });

  it("is off when unset, empty, or anything else", () => {
    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      expect(hideDestinationFrom({ [HIDE_DESTINATION_ENV_VAR]: value })).toBe(false);
    }
    expect(hideDestinationFrom({})).toBe(false);
  });

  it("drives wordingFromEnv", () => {
    expect(wordingFromEnv({}).hidden).toBe(false);
    expect(wordingFromEnv({ DWH_HIDE_DESTINATION: "1" }).hidden).toBe(true);
  });
});

describe("redactWebhookTokens", () => {
  it("keeps the id but hides the token", () => {
    const redacted = redactWebhookTokens(`error at ${WEBHOOK} and https://discord.com/api/v10/webhooks/9/tok-en_1`);
    expect(redacted).toBe(
      "error at https://discord.com/api/webhooks/123456789/<token> and https://discord.com/api/v10/webhooks/9/<token>",
    );
  });
});

describe("neutralize", () => {
  it("replaces whole webhook URLs, query string included", () => {
    expect(neutralize(`fetch failed for ${WEBHOOK}?wait=true&thread_id=4`)).toBe("fetch failed for <destination>");
    expect(neutralize("see https://ptb.discord.com/api/v10/webhooks/1/t-t")).toBe("see <destination>");
  });

  it("replaces hostnames, the brand, the word webhook, and the configuration variable names", () => {
    expect(neutralize("Unknown Webhook")).toBe("Unknown destination");
    expect(neutralize("getaddrinfo ENOTFOUND discord.com")).toBe("getaddrinfo ENOTFOUND the destination");
    expect(neutralize("cdn.discordapp.com is slow")).toBe("the destination is slow");
    expect(neutralize("Discord rejected it; the webhooks list; DISCORD_WEBHOOK_URL and DWH_WEBHOOK_URL")).toBe(
      "the destination rejected it; the destination list; the dwh configuration and the dwh configuration",
    );
  });

  it("replaces any other URL on the service's hosts whole", () => {
    expect(neutralize("from https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2 ok")).toBe(
      "from <destination> ok",
    );
    expect(neutralize("see https://discord.com/channels/1/2/3 now")).toBe("see <destination> now");
    expect(neutralize("https://discord.com")).toBe("<destination>");
  });

  it("leaves unrelated text alone, but replaces the bare words wherever they appear", () => {
    expect(neutralize("report.md: no such file")).toBe("report.md: no such file");
    expect(neutralize("https://example.com/guide.html")).toBe("https://example.com/guide.html");
    expect(neutralize("discord-export.zip")).toBe("the destination-export.zip");
  });
});

describe("wordingFor", () => {
  it("names the service in branded mode and never in neutral mode", () => {
    const branded = wordingFor(false);
    const neutral = wordingFor(true);
    expect(branded.hidden).toBe(false);
    expect(branded.service).toBe("Discord");
    expect(neutral.hidden).toBe(true);
    const neutralTexts = [
      neutral.service,
      neutral.Service,
      neutral.tooLarge("120.0 MiB", "100.0 MiB"),
      neutral.uploadLimitHelp("big.bin (30.0 MiB)"),
      neutral.uploadLimitHelp(undefined),
      neutral.badDestinationHelp,
      neutral.badThreadHelp,
      neutral.notConfigured.message,
      neutral.notConfigured.help,
      neutral.invalidConfig("DWH_WEBHOOK_URL", "not-a-url").message,
      neutral.invalidConfig("DWH_WEBHOOK_URL", "not-a-url").help,
      neutral.invalidConfig("DISCORD_WEBHOOK_URL", "not-a-webhook").message,
      neutral.invalidConfig("DISCORD_WEBHOOK_URL", "not-a-webhook").help,
    ];
    for (const text of neutralTexts) {
      expect(text).not.toMatch(FORBIDDEN);
    }
  });

  it("scrubs tokens in branded mode and every trace of the service in neutral mode", () => {
    const text = `Unknown Webhook while posting to ${WEBHOOK}`;
    expect(wordingFor(false).scrub(text)).toBe(
      "Unknown Webhook while posting to https://discord.com/api/webhooks/123456789/<token>",
    );
    expect(wordingFor(true).scrub(text)).toBe("Unknown destination while posting to <destination>");
    expect(wordingFor(true).scrub(text)).not.toMatch(FORBIDDEN);
  });
});
