import { send, sendOperation } from "../../_generated/dwh/send.js";
import type { RequestOptions } from "../../api/http.js";
import { clientFor, destinationOf, validateDirectUrl } from "../../destination.js";
import { isRecord, stringField } from "../../lib/json.js";
import { wordingFor } from "../../lib/wording.js";
import type { OutgoingFile } from "./inputs.js";

export const MAX_FILES_PER_MESSAGE: number = sendOperation.body.files[0].parts.length;

export const MAX_BATCH_BYTES: number = sendOperation.upload.maxRequestBytes;

export function planBatches(files: readonly OutgoingFile[]): OutgoingFile[][] {
  const batches: OutgoingFile[][] = [];
  let current: OutgoingFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const size = file.data.byteLength;
    if (
      current.length > 0 &&
      (current.length >= MAX_FILES_PER_MESSAGE || currentBytes + size > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export interface Delivery {
  readonly file: OutgoingFile;
  readonly message: number;
  readonly messageId: string | undefined;
  readonly channelId: string | undefined;
  readonly attachmentId: string | undefined;
  readonly url: string | undefined;
}

export interface SendResult {
  readonly deliveries: readonly Delivery[];
  readonly messages: number;
}

export interface SendOptions extends RequestOptions {
  onSent?: ((file: OutgoingFile, delivery: Delivery) => void) | undefined;
}

export async function sendFiles(
  webhookUrl: string,
  files: readonly OutgoingFile[],
  options: SendOptions = {},
): Promise<SendResult> {
  const destination = destinationOf(
    validateDirectUrl(webhookUrl, wordingFor(options.hideDestination)),
  );
  if (files.length === 0) {
    return { deliveries: [], messages: 0 };
  }
  const client = clientFor(destination, options);
  const batches = planBatches(files);
  const deliveries: Delivery[] = [];
  for (const [index, batch] of batches.entries()) {
    const result = await send(client, { ...destination.params, wait: true, files: batch });
    const message = messageOf(result.body);
    for (const [position, file] of batch.entries()) {
      const attachment = message.attachments[position];
      const delivery: Delivery = {
        file,
        message: index + 1,
        messageId: message.id,
        channelId: message.channelId,
        attachmentId: attachment?.id,
        url: attachment?.url,
      };
      deliveries.push(delivery);
      options.onSent?.(file, delivery);
    }
    const { remaining, resetAfterMs } = result.rateLimit;
    if (index < batches.length - 1 && remaining === 0 && resetAfterMs > 0) {
      await client.pauseForRateLimit(resetAfterMs);
    }
  }
  return { deliveries, messages: batches.length };
}

interface MessageInfo {
  readonly id: string | undefined;
  readonly channelId: string | undefined;
  readonly attachments: ReadonlyArray<{
    readonly id: string | undefined;
    readonly url: string | undefined;
  }>;
}

function messageOf(body: unknown): MessageInfo {
  const record = isRecord(body) ? body : {};
  const rawAttachments: unknown = record["attachments"];
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments.map((entry: unknown) => {
        const attachment = isRecord(entry) ? entry : {};
        return { id: stringField(attachment, "id"), url: stringField(attachment, "url") };
      })
    : [];
  return {
    id: stringField(record, "id"),
    channelId: stringField(record, "channel_id"),
    attachments,
  };
}
