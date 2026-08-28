import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '../../context/index.js';

const HEADER = 'x-request-id';
const MAX_INCOMING_LENGTH = 200;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(HEADER);
    const id =
      incoming !== undefined && incoming.length > 0 && incoming.length <= MAX_INCOMING_LENGTH
        ? incoming
        : `req_${randomUUID()}`;

    res.setHeader(HEADER, id);
    runWithContext(id, next);
  };
}
