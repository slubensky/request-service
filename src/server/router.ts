import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Minimal request context passed to route handlers. Kept small and typed
 * rather than reaching for a framework's Request/Response abstraction.
 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segment values captured from `:param` placeholders in the route pattern. */
  params: Readonly<Record<string, string>>;
  /** Parsed query string parameters. */
  query: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

interface Route {
  method: HttpMethod;
  /** Compiled matcher segments for the route pattern, e.g. "/bathrooms/:id". */
  segments: readonly string[];
  handler: RouteHandler;
}

function splitPath(pattern: string): string[] {
  return pattern.split('/').filter((segment) => segment.length > 0);
}

/**
 * A small typed router for exact-method matching with `:param` path segments.
 * Deliberately minimal: no middleware chains, no wildcard globbing, no
 * dependency on Express/Fastify/Next -- just enough dispatch for an SSR app.
 */
export class Router {
  private readonly routes: Route[] = [];

  get(pattern: string, handler: RouteHandler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.add('POST', pattern, handler);
  }

  add(method: HttpMethod, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: splitPath(pattern), handler });
  }

  /**
   * Matches a method + pathname against registered routes, returning the
   * handler and any captured params, or `undefined` if nothing matches.
   */
  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | undefined {
    const requestSegments = splitPath(pathname);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== requestSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const routeSegment = route.segments[i];
        const requestSegment = requestSegments[i];
        if (routeSegment === undefined || requestSegment === undefined) {
          matched = false;
          break;
        }
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
        } else if (routeSegment !== requestSegment) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return { handler: route.handler, params };
      }
    }

    return undefined;
  }
}
