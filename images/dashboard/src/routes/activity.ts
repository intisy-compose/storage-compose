import type { ActivitySource } from "../api/types.js";
import { type ActivityQuery, activityLog } from "../eventFeed.js";
import { RequestError, sendJson } from "../http.js";
import type { Route } from "../routes.js";

const sources: ActivitySource[] = ["syncthing", "parity", "dashboard"];

function sourceOf(value: string | null): ActivitySource | null {
  if (!value) return null;
  if (!sources.includes(value as ActivitySource)) throw new RequestError(400, `source is one of ${sources.join(", ")}`);
  return value as ActivitySource;
}

function limitOf(value: string | null): number | undefined {
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new RequestError(400, "limit is a whole number above 0");
  return limit;
}

export function activityQuery(url: URL): ActivityQuery {
  const parameter = (name: string) => url.searchParams.get(name) || null;
  return {
    after: parameter("after"),
    node: parameter("node"),
    folder: parameter("folder"),
    types: (parameter("type") ?? "").split(",").map((type) => type.trim()).filter(Boolean),
    source: sourceOf(parameter("source")),
    routine: parameter("routine") !== "false",
    limit: limitOf(parameter("limit")),
  };
}

export const activityRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/activity$/,
    handle: async ({ response, url }) => sendJson(response, 200, activityLog.query(activityQuery(url))),
  },
];
