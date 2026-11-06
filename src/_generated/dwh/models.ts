/* eslint-disable */

export interface ApplicationIncomingWebhookResponse {
  readonly id: SnowflakeType;
  readonly type: 3;
  readonly name: string;
  readonly avatar: string | null;
  readonly channel_id: SnowflakeType | null;
  readonly guild_id?: SnowflakeType | null;
  readonly application_id: SnowflakeType | null;
}

export interface ChannelFollowerWebhookResponse {
  readonly id: SnowflakeType;
  readonly type: 2;
  readonly name: string;
  readonly avatar: string | null;
  readonly channel_id: SnowflakeType | null;
  readonly guild_id?: SnowflakeType | null;
  readonly application_id: SnowflakeType | null;
  readonly source_guild?: WebhookSourceGuildResponse;
  readonly source_channel?: WebhookSourceChannelResponse;
}

export interface ErrorResponse {
  readonly code: number;
  readonly message: string;
  readonly errors?: { readonly [key: string]: unknown };
}

export interface FilesOnlyMessageRequest {
  readonly "files[0]"?: Uint8Array;
  readonly "files[1]"?: Uint8Array;
  readonly "files[2]"?: Uint8Array;
  readonly "files[3]"?: Uint8Array;
  readonly "files[4]"?: Uint8Array;
  readonly "files[5]"?: Uint8Array;
  readonly "files[6]"?: Uint8Array;
  readonly "files[7]"?: Uint8Array;
  readonly "files[8]"?: Uint8Array;
  readonly "files[9]"?: Uint8Array;
}

export interface GuildIncomingWebhookResponse {
  readonly id: SnowflakeType;
  readonly type: 1;
  readonly name: string;
  readonly avatar: string | null;
  readonly channel_id: SnowflakeType | null;
  readonly guild_id?: SnowflakeType | null;
  readonly application_id: SnowflakeType | null;
  readonly token?: string;
  readonly url?: string;
}

export interface MessageAttachmentResponse {
  readonly id: SnowflakeType;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly proxy_url: string;
  readonly content_type?: string;
}

export interface MessageResponse {
  readonly id: SnowflakeType;
  readonly channel_id: SnowflakeType;
  readonly webhook_id?: SnowflakeType;
  readonly timestamp: string;
  readonly attachments: readonly MessageAttachmentResponse[];
}

export interface RatelimitedResponse {
  readonly code: number;
  readonly message: string;
  readonly retry_after: number;
  readonly global: boolean;
}

export type SnowflakeType = string;

export type WebhookResponse =
  | GuildIncomingWebhookResponse
  | ChannelFollowerWebhookResponse
  | ApplicationIncomingWebhookResponse;

export interface WebhookSourceChannelResponse {
  readonly id: SnowflakeType;
  readonly name: string;
}

export interface WebhookSourceGuildResponse {
  readonly id: SnowflakeType;
  readonly icon: string | null;
  readonly name: string;
}
