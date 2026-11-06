/* eslint-disable */

import type { ApiResult, Client } from "../../api/client.js";
import type {
  DeclaredOperation,
  FilesBody,
  UploadFile,
  UploadLimits,
} from "../../api/operation.js";
import type { MessageResponse, SnowflakeType } from "./models.js";

export const sendOperation: DeclaredOperation<FilesBody, UploadLimits> = {
  id: "dwh.send",
  method: "POST",
  template: "/webhooks/{webhook_id}/{webhook_token}",
  query: ["wait", "thread_id"],
  body: {
    kind: "multipart",
    files: [
      {
        field: "files",
        parts: [
          "files[0]",
          "files[1]",
          "files[2]",
          "files[3]",
          "files[4]",
          "files[5]",
          "files[6]",
          "files[7]",
          "files[8]",
          "files[9]",
        ],
      },
    ],
  },
  response: "json",
  errors: [
    { status: 413, kind: "too-large" },
    { code: 40005, kind: "too-large" },
    { code: 10003, kind: "stale-thread" },
    { code: 10015, kind: "bad-destination" },
    { code: 50027, kind: "bad-destination" },
    { status: 401, kind: "bad-destination" },
    { status: 403, kind: "bad-destination" },
    { status: 404, kind: "bad-destination" },
    { code: 50035, kind: "invalid-form" },
  ],
  upload: { maxRequestBytes: 25165824, defaultFileBytes: 10485760, maxFileBytes: 104857600 },
};

export interface SendRequest {
  readonly webhook_id: SnowflakeType;
  readonly webhook_token: string;
  readonly wait?: boolean | undefined;
  readonly thread_id?: SnowflakeType | undefined;
  readonly files: readonly UploadFile[];
}

export type SendResponse = MessageResponse;

export function send(client: Client, request: SendRequest): Promise<ApiResult> {
  return client.send(sendOperation, request);
}
