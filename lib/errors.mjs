// An error that carries the HTTP status the API should answer with. Engine
// modules throw these for bad input so the server can map them directly.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const bad = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);
