/* eslint-disable */

import type { ApiResult, Client } from "../../api/client.js";
import type { DeclaredOperation } from "../../api/operation.js";
import type { SnowflakeType, WebhookResponse } from "./models.js";

export const checkOperation: DeclaredOperation<undefined, undefined> = {
  id: "dwh.check",
  method: "GET",
  template: "/webhooks/{webhook_id}/{webhook_token}",
  query: [],
  body: undefined,
  response: "json",
  errors: [
    { code: 10015, kind: "bad-destination" },
    { code: 50027, kind: "bad-destination" },
    { status: 401, kind: "bad-destination" },
    { status: 403, kind: "bad-destination" },
    { status: 404, kind: "bad-destination" },
  ],
  upload: undefined,
};

export interface CheckRequest {
  readonly webhook_id: SnowflakeType;
  readonly webhook_token: string;
}

export type CheckResponse = WebhookResponse;

export function check(client: Client, request: CheckRequest): Promise<ApiResult> {
  return client.send(checkOperation, request);
}
