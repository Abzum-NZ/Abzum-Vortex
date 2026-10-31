/** One JSON POST answer: the HTTP status, the parsed body where read, and the response itself. */
export type JsonPostResult<Value> = Readonly<{
  status: number;
  ok: boolean;
  /** The parsed JSON body; undefined when the caller reads the response as a stream. */
  body: Value;
  response: Response;
}>;

/**
 * Posts one JSON body to this site's own API. Every client POST uses this one call, so the method,
 * the media type, the credentials, the cache rule and the signal are written once. The caller reads
 * the status as well as the body: a route that refuses a session and a route that refuses a request
 * do not answer the same status. A streaming answer passes `read: "stream"` and is read from
 * `response`; everything else answers JSON and is parsed here.
 */
export const postJson = async <Value = unknown>(
  endpoint: string,
  body: unknown,
  options?: Readonly<{
    signal?: AbortSignal;
    read?: "json" | "stream";
    fetchImplementation?: typeof fetch;
  }>,
): Promise<JsonPostResult<Value>> => {
  const send = options?.fetchImplementation ?? fetch;
  const response = await send(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    body: JSON.stringify(body),
  });
  if (options?.read === "stream")
    return { status: response.status, ok: response.ok, body: undefined as Value, response };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new Error(`POST ${endpoint} answered ${response.status} without a JSON body`, {
      cause: error,
    });
  }
  return { status: response.status, ok: response.ok, body: parsed as Value, response };
};
