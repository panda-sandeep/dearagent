import type { Config } from '../env';
import { ApiError } from '../api/errors';
import type { MessageRow } from '../db/schema';

const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const MAX_BODY_CHARS = 50_000;

export const DEFAULT_RESULT_SCHEMA = {
	type: 'object',
	properties: { result: { type: 'string' } },
	required: ['result'],
	additionalProperties: false,
} as const;

export interface ExtractInput {
	prompt: string;
	/** JSON Schema for the output. Defaults to `{ result: string }`. */
	schema?: Record<string, unknown>;
}

export interface ExtractOutput {
	result: unknown;
	provider: 'workers-ai' | 'openai';
	model: string;
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
		.replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, ' $1 ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function buildPrompt(message: MessageRow, prompt: string): { system: string; user: string } {
	const fromText = message.from_name ? `${message.from_name} <${message.from_address}>` : (message.from_address ?? '');
	const body = (message.text && message.text.trim()) || (message.html ? stripHtml(message.html) : '');
	const system =
		'You extract specific data from emails and return it as JSON that matches the provided schema. ' +
		'Return only what the instructions ask for, with no commentary. If the answer is a single value (a link, a code, a name), ' +
		'return exactly that value with no surrounding text.';
	const user =
		`Here is the email.\n\nFrom: ${fromText}\nSubject: ${message.subject ?? ''}\nReceived: ${new Date(message.received_at).toISOString()}\n\n` +
		`Body:\n${body.slice(0, MAX_BODY_CHARS)}\n\n=====\n\nInstructions: ${prompt}`;
	return { system, user };
}

function parseJsonLoose(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error('Model did not return JSON');
	}
}

async function runWorkersAi(env: Env, model: string, system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
	if (!env.AI) throw ApiError.notConfigured('Workers AI binding "AI" is missing from wrangler.jsonc');
	const ai = env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> };
	let out: unknown;
	try {
		out = await ai.run(model, {
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			response_format: { type: 'json_schema', json_schema: schema },
			max_tokens: 2048,
		});
	} catch (error) {
		throw ApiError.upstream(`Workers AI error: ${error instanceof Error ? error.message : String(error)}`);
	}
	const response = (out as { response?: unknown })?.response ?? out;
	if (typeof response === 'string') return parseJsonLoose(response);
	return response;
}

async function runOpenAi(env: Env, model: string, system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
	if (!env.OPENAI_API_KEY) throw ApiError.notConfigured('AI_PROVIDER=openai but the OPENAI_API_KEY secret is not set');
	const res = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
		body: JSON.stringify({
			model,
			input: [
				{ role: 'developer', content: system },
				{ role: 'user', content: user },
			],
			text: { format: { type: 'json_schema', name: 'extraction', schema, strict: true } },
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw ApiError.upstream(`OpenAI error ${res.status}`, detail.slice(0, 500));
	}
	const data = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
	const text = data.output_text ?? data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;
	if (!text) throw ApiError.upstream('OpenAI returned no text output');
	return parseJsonLoose(text);
}

export async function extractFromMessage(env: Env, config: Config, message: MessageRow, input: ExtractInput): Promise<ExtractOutput> {
	if (!message.text && !message.html) throw ApiError.badRequest('Message has no text or HTML body to extract from');
	const schema = input.schema ?? (DEFAULT_RESULT_SCHEMA as unknown as Record<string, unknown>);
	const { system, user } = buildPrompt(message, input.prompt);

	if (config.aiProvider === 'openai') {
		const model = config.aiModel || DEFAULT_OPENAI_MODEL;
		const parsed = await runOpenAi(env, model, system, user, schema);
		return { result: unwrap(parsed, input.schema), provider: 'openai', model };
	}
	const model = config.aiModel || DEFAULT_WORKERS_AI_MODEL;
	const parsed = await runWorkersAi(env, model, system, user, schema);
	return { result: unwrap(parsed, input.schema), provider: 'workers-ai', model };
}

/** With the default schema, callers get the bare string; with a custom schema they get the whole object. */
function unwrap(parsed: unknown, customSchema?: Record<string, unknown>): unknown {
	if (customSchema) return parsed;
	if (parsed && typeof parsed === 'object' && 'result' in parsed) return (parsed as { result: unknown }).result;
	return parsed;
}
