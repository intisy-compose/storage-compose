import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** The route pattern's capture groups. */
  params: string[];
}

/** What a write changed, in words, for Activity: `pc: renamed device dashboard-test-peer to backup`. */
export interface WriteNote {
  nodeId: string;
  nodeName: string;
  folderId: string | null;
  text: string;
}

type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

declare const hostWriteBrand: unique symbol;

/** The pattern of a write that is no node's, made only by `hostWritePattern`. */
export type HostWritePattern = RegExp & { readonly [hostWriteBrand]: true };

const nodeProbePaths = ["/api/nodes/x", "/api/nodes/x/y", "/api/nodes/x/y/z"];

/** The path a pattern stands for with each group filled by one segment: `/api/nodes/x/devices` for `^\/api\/nodes\/([^/]+)\/devices$`. */
function samplePath(pattern: RegExp): string {
  return pattern.source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/").replace(/\((?:[^()]|\([^()]*\))*\)/g, "x");
}

/** Whether a route pattern answers paths under /api/nodes/: it takes a probe path, such as through an alternation, or the path it stands for is one. */
export function isNodePattern(pattern: RegExp): boolean {
  return nodeProbePaths.some((probe) => pattern.test(probe)) || samplePath(pattern).startsWith("/api/nodes/");
}

/**
 * Marks a write route's pattern as no node's.
 * @implNote It refuses a path under /api/nodes/, so the only way to declare a write there is a `NodeWriteRoute`, which has to name its change for Activity.
 */
export function hostWritePattern(pattern: RegExp): HostWritePattern {
  if (isNodePattern(pattern)) throw new Error(`${pattern} is a node's path: declare its write as a NodeWriteRoute`);
  return pattern as HostWritePattern;
}

interface ReadRoute {
  method: "GET";
  pattern: RegExp;
  handle: (context: RouteContext) => Promise<void>;
}

/** A write that is no node's, such as an array action; any method when `method` is absent. */
interface HostWriteRoute {
  method?: WriteMethod;
  pattern: HostWritePattern;
  handle: (context: RouteContext) => Promise<void>;
}

export type Route = ReadRoute | HostWriteRoute;

/** A node write's answer when it found nothing to change, so Activity does not record a write that never happened. */
export interface NothingWritten {
  nothingWritten: true;
}

/** What a node write hands back: its note, one note for each node a write to several of them changed, or that it wrote nothing. */
export type WriteOutcome = WriteNote | [WriteNote, ...WriteNote[]] | NothingWritten;

/** A write to a node: it must answer with the note Activity records, or say outright that it wrote nothing, so a write that names nothing does not compile. */
export interface NodeWriteRoute {
  method: WriteMethod;
  pattern: RegExp;
  write: (context: RouteContext) => Promise<WriteOutcome>;
}

export type AnyRoute = Route | NodeWriteRoute;
