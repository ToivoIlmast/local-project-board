import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  parseBody,
  parseParams,
  parseQuery,
  routeList,
  type HttpMethod,
  type Route,
} from '../../../contract/v1/index.js';
import type { BoardContext } from '../context.js';
import { HttpError, invalidRequest } from '../errors.js';
import { EMBEDDED_HTML_CSP } from '../security.js';
import { handlers, isTextBody, type TextBody } from './handlers.js';

/** Above the largest document the contract allows, so the schema reports the real reason. */
export const JSON_BODY_LIMIT = '2mb';

type Serve = (
  context: BoardContext,
  input: { params: unknown; query: unknown; body: unknown },
) => Promise<unknown>;

/**
 * The router is built from the route table, so a route cannot exist without a contract and
 * a contract cannot silently lose its route (ADR-0005).
 */
export function createV1Router(context: BoardContext): Router {
  const router = Router();
  router.use(express.json({ limit: JSON_BODY_LIMIT }));

  const methodsByPath = new Map<string, HttpMethod[]>();
  for (const route of routeList) {
    const handler = handlers[route.id as keyof typeof handlers];
    if (!handler) continue;
    // The handler is typed per route id; the router only knows that the contract validated it.
    router[verb(route.method)](route.path, serve(context, route, handler as unknown as Serve));
    methodsByPath.set(route.path, [...(methodsByPath.get(route.path) ?? []), route.method]);
  }

  for (const [path, methods] of methodsByPath) {
    router.all(path, (_request, response) => {
      response.setHeader('Allow', methods.join(', '));
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This route does not take that method.');
    });
  }

  router.use(() => {
    throw new HttpError(404, 'NOT_FOUND', 'This endpoint does not exist.');
  });
  return router;
}

function serve(context: BoardContext, route: Route, handler: Serve) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const params = parseParams(route, request.params);
        if (!params.ok) throw invalidRequest(params.issues);
        const query = parseQuery(route, request.query);
        if (!query.ok) throw invalidRequest(query.issues);
        const body = parseBody(route, request.body);
        if (!body.ok) throw invalidRequest(body.issues);

        const result = await handler(context, {
          params: params.data,
          query: query.data,
          body: body.data,
        });
        respond(response, route, result);
      } catch (error) {
        next(error);
      }
    })();
  };
}

function respond(response: Response, route: Route, result: unknown): void {
  const status = route.successStatus ?? 200;
  if (route.response.media === 'application/json') {
    response.status(status).json(result);
    return;
  }
  const body: TextBody = isTextBody(result)
    ? result
    : { text: String(result), media: 'text/markdown' };
  if (body.media === 'text/html') response.setHeader('Content-Security-Policy', EMBEDDED_HTML_CSP);
  response.status(status).type(`${body.media}; charset=utf-8`).send(body.text);
}

function verb(method: HttpMethod): 'get' | 'post' | 'patch' | 'put' | 'delete' {
  return method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
}
