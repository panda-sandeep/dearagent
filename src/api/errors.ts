export class ApiError extends Error {
	status: number;
	code: string;
	details?: unknown;
	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.status = status;
		this.code = code;
		this.details = details;
	}

	static badRequest(message: string, details?: unknown) {
		return new ApiError(400, 'bad_request', message, details);
	}
	static unauthorized(message = 'Missing or invalid bearer token') {
		return new ApiError(401, 'unauthorized', message);
	}
	static notFound(what: string) {
		return new ApiError(404, 'not_found', `${what} not found`);
	}
	static conflict(message: string) {
		return new ApiError(409, 'conflict', message);
	}
	static tooLarge(message: string) {
		return new ApiError(413, 'payload_too_large', message);
	}
	static upstream(message: string, details?: unknown) {
		return new ApiError(502, 'upstream_error', message, details);
	}
	static notConfigured(message: string) {
		return new ApiError(503, 'not_configured', message);
	}
}
