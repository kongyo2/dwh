import { check } from "../../_generated/dwh/check.js";
import type { RequestOptions } from "../../api/http.js";
import { clientFor, destinationOf, validateDirectUrl } from "../../destination.js";
import { isRecord, numberField, stringField } from "../../lib/json.js";
import { wordingFor } from "../../lib/wording.js";

export interface WebhookInfo {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly type: number | undefined;
  readonly channelId: string | undefined;
  readonly guildId: string | undefined;
}

export type CheckOptions = RequestOptions;

export async function checkWebhook(
  webhookUrl: string,
  options: CheckOptions = {},
): Promise<WebhookInfo> {
  const destination = destinationOf(
    validateDirectUrl(webhookUrl, wordingFor(options.hideDestination)),
  );
  const result = await check(clientFor(destination, options), destination.params);
  const record = isRecord(result.body) ? result.body : {};
  return {
    id: stringField(record, "id"),
    name: stringField(record, "name"),
    type: numberField(record, "type"),
    channelId: stringField(record, "channel_id"),
    guildId: stringField(record, "guild_id"),
  };
}
