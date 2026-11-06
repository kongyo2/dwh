export type ErrorKind = "bad-destination" | "stale-thread" | "too-large" | "invalid-form";

export interface ErrorRule {
  readonly code?: number | undefined;
  readonly status?: number | undefined;
  readonly kind: ErrorKind;
}

export interface UploadLimits {
  readonly maxRequestBytes: number;
  readonly defaultFileBytes: number;
  readonly maxFileBytes: number;
}

export interface FileParts {
  readonly field: string;
  readonly parts: readonly string[];
}

export interface FilesBody {
  readonly kind: "multipart";
  readonly files: readonly [FileParts, ...FileParts[]];
}

export interface Operation {
  readonly id: string;
  readonly method: string;
  readonly template: string;
  readonly query: readonly string[];
  readonly body: FilesBody | undefined;
  readonly response: "json" | "none";
  readonly errors: readonly ErrorRule[];
  readonly upload: UploadLimits | undefined;
}

export interface DeclaredOperation<
  Body extends FilesBody | undefined = FilesBody | undefined,
  Upload extends UploadLimits | undefined = UploadLimits | undefined,
> extends Operation {
  readonly body: Body;
  readonly upload: Upload;
}

export interface UploadFile {
  readonly name: string;
  readonly data: Uint8Array;
  readonly contentType: string;
}
