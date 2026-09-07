import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type Command =
  | DeleteObjectsCommand
  | GetObjectCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | ListObjectsV2Command
  | PutObjectCommand;

type Sender = {
  send(command: Command): Promise<unknown>;
  destroy?: () => void;
};

function status(error: unknown) {
  return error && typeof error === 'object' && '$metadata' in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
}

function missing(error: unknown) {
  return (
    status(error) === 404 ||
    (error &&
      typeof error === 'object' &&
      'name' in error &&
      ['NoSuchKey', 'NotFound'].includes(String(error.name)))
  );
}

export function createObjects(
  options: { bucket?: string; client?: Sender } = {},
) {
  const bucket = options.bucket ?? process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is required');
  const client: Sender =
    options.client ??
    new S3Client({
      region: process.env.AWS_REGION ?? 'ap-southeast-2',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });

  async function exists(key: string) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  return {
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    async putImmutable(key: string, body: string) {
      if (await exists(key)) return;
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/json',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (status(error) !== 412) throw error;
      }
    },

    async getText(key: string) {
      try {
        const result = (await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as { Body?: { transformToString(): Promise<string> } };
        if (!result.Body) throw new Error('S3 object body is missing');
        return result.Body.transformToString();
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },

    async deletePrefix(prefix: string) {
      let continuationToken: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )) as {
          Contents?: Array<{ Key?: string }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        const keys = (page.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => Boolean(key));
        if (keys.length) {
          const deleted = (await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          )) as { Errors?: Array<{ Key?: string; Code?: string }> };
          if (deleted.Errors?.length) {
            throw new Error(
              `S3 delete failed: ${deleted.Errors.map((item) => `${item.Key ?? '?'}:${item.Code ?? 'Unknown'}`).join(', ')}`,
            );
          }
        }
        if (!page.IsTruncated) break;
        if (!page.NextContinuationToken)
          throw new Error(
            'S3 truncated listing omitted its continuation token',
          );
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    },

    close() {
      client.destroy?.();
    },
  };
}

export type Objects = ReturnType<typeof createObjects>;
