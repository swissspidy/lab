import Anthropic, { APIError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';
import { StageError } from '@lab/core';

export interface ModelRequest {
	/** Stable instructions. */
	system: string;
	/** The task, with the site's files and the ledger history as data. */
	prompt: string;
	/** What the request is for, so scripted providers can answer by kind. */
	kind: 'propose' | 'build' | 'tweak';
}

/** The only way the lab reaches a model. Tests use `ScriptedProvider`, so CI needs no key. */
export interface ModelProvider {
	readonly id: string;
	complete(request: ModelRequest): Promise<string>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicProviderOptions {
	/** Defaults to `LAB_MODEL`, then `claude-opus-5-5`. */
	model?: string;
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	maxTokens?: number;
	client?: Anthropic;
}

/**
 * Claude through the official SDK. Credentials come from the environment
 * (`ANTHROPIC_API_KEY` or an `ant auth login` profile). On a refusal the API
 * falls back to another model by itself; a refusal from the whole chain is a
 * stage error.
 */
export class AnthropicProvider implements ModelProvider {
	readonly id: string;
	private readonly effort: NonNullable<AnthropicProviderOptions['effort']>;
	private readonly maxTokens: number;
	private readonly client: Anthropic;

	constructor(options: AnthropicProviderOptions = {}) {
		this.id = options.model ?? process.env.LAB_MODEL ?? DEFAULT_MODEL;
		this.effort = options.effort ?? 'high';
		this.maxTokens = options.maxTokens ?? 64_000;
		this.client = options.client ?? new Anthropic();
	}

	async complete(request: ModelRequest): Promise<string> {
		let message;
		try {
			const stream = this.client.beta.messages.stream({
				model: this.id,
				max_tokens: this.maxTokens,
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
				output_config: { effort: this.effort },
				system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: request.prompt }],
			});
			message = await stream.finalMessage();
		} catch (error) {
			if (error instanceof AuthenticationError) throw new StageError('model-auth', 'The model API rejected the credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.');
			if (error instanceof RateLimitError) throw new StageError('model-rate-limited', 'The model API is rate limiting this key. Try again later.');
			if (error instanceof APIError) throw new StageError('model-error', `The model API failed with ${error.status}: ${error.message}`);
			throw new StageError('model-unavailable', `Could not reach the model: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (message.stop_reason === 'refusal') throw new StageError('model-refused', 'The model declined the request.');
		if (message.stop_reason === 'max_tokens') throw new StageError('model-truncated', 'The model ran out of output tokens before finishing.');
		return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
	}
}

type Script = string | ((request: ModelRequest) => string);

/**
 * Answers from a script, in order, per request kind. Records every request
 * so tests can check what the model was shown.
 */
export class ScriptedProvider implements ModelProvider {
	readonly id = 'scripted';
	readonly requests: ModelRequest[] = [];
	private readonly queues: Record<ModelRequest['kind'], Script[]>;

	constructor(script: { propose?: Script[]; build?: Script[]; tweak?: Script[] }) {
		this.queues = { propose: [...(script.propose ?? [])], build: [...(script.build ?? [])], tweak: [...(script.tweak ?? [])] };
	}

	async complete(request: ModelRequest): Promise<string> {
		this.requests.push(request);
		const next = this.queues[request.kind].shift();
		if (next === undefined) throw new StageError('model-script-exhausted', `The script has no ${request.kind} answer left.`);
		return typeof next === 'function' ? next(request) : next;
	}

	remaining(kind: ModelRequest['kind']): number {
		return this.queues[kind].length;
	}
}
