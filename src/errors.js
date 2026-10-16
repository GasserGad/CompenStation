// Errors that are safe to show to clients. Anything else becomes a generic 500,
// so stack traces, SQL and internal details never reach the browser.

export class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {object} [details] safe extra info (e.g. which fields failed validation)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** @param {string} message @param {object} [details] */
export const badRequest = (message, details) => new AppError(400, "bad_request", message, details);
export const unauthorized = () => new AppError(401, "unauthorized", "Please log in.");
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, "forbidden", message);
/** @param {string} what */
export const notFound = (what) => new AppError(404, "not_found", `${what} not found.`);
/** @param {string} message */
export const conflict = (message) => new AppError(409, "conflict", message);
