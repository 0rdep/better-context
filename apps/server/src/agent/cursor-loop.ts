/**
 * Cursor CLI Agent Loop
 * Shells out to the Cursor CLI `agent` command for processing questions
 * Uses stream-json output format for structured event parsing
 */

import type { AgentLoop } from './loop.ts';

export namespace CursorLoop {
	// Reuse the same event types from AgentLoop for consistency
	export type CursorEvent = AgentLoop.AgentEvent;

	// Options for the cursor loop
	export type Options = {
		collectionPath: string;
		question: string;
		agentInstructions: string;
		model?: string;
		timeoutMs?: number;
		onInit?: (args: { model: string }) => void;
	};

	// Result type
	export type Result = {
		answer: string;
		model: { provider: string; model: string };
		events: CursorEvent[];
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// Cursor CLI JSON Event Types (from stream-json output format)
	// ─────────────────────────────────────────────────────────────────────────────

	type CursorSystemEvent = {
		type: 'system';
		subtype: 'init';
		apiKeySource: string;
		cwd: string;
		session_id: string;
		model: string;
		permissionMode: string;
	};

	type CursorUserEvent = {
		type: 'user';
		message: {
			role: 'user';
			content: Array<{ type: 'text'; text: string }>;
		};
		session_id: string;
	};

	type CursorAssistantEvent = {
		type: 'assistant';
		message: {
			role: 'assistant';
			content: Array<{ type: 'text'; text: string }>;
		};
		session_id: string;
		timestamp_ms?: number; // Present on streaming delta events, absent on final/summary events
		model_call_id?: string; // Present on duplicate "finalized" events before tool calls
	};

	// Generic tool call structure - Cursor has many tool types
	type CursorToolCall = {
		readToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		writeToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		globToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		grepToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		listToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		bashToolCall?: {
			args: Record<string, unknown>;
			result?: { success?: Record<string, unknown> };
		};
		function?: { name: string; arguments: string };
		// Catch-all for any other tool types
		[key: string]: unknown;
	};

	type CursorToolCallStartedEvent = {
		type: 'tool_call';
		subtype: 'started';
		call_id: string;
		tool_call: CursorToolCall;
		session_id: string;
	};

	type CursorToolCallCompletedEvent = {
		type: 'tool_call';
		subtype: 'completed';
		call_id: string;
		tool_call: CursorToolCall;
		session_id: string;
	};

	type CursorResultEvent = {
		type: 'result';
		subtype: 'success';
		duration_ms: number;
		duration_api_ms: number;
		is_error: boolean;
		result: string;
		session_id: string;
		request_id?: string;
	};

	type CursorJsonEvent =
		| CursorSystemEvent
		| CursorUserEvent
		| CursorAssistantEvent
		| CursorToolCallStartedEvent
		| CursorToolCallCompletedEvent
		| CursorResultEvent;

	// ─────────────────────────────────────────────────────────────────────────────
	// Helper Functions
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * Check if the Cursor CLI is installed
	 */
	async function isCursorInstalled(): Promise<boolean> {
		try {
			// Avoid shelling out to `which` for portability (Windows/minimal containers).
			const agentPath = Bun.which('agent');
			return typeof agentPath === 'string' && agentPath.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Build the full prompt with system instructions, agent context, and user question
	 */
	function buildFullPrompt(agentInstructions: string, question: string): string {
		const systemPrompt = [
			'You are btca, an expert documentation search agent.',
			'Your job is to answer questions by searching through the collection of resources in the current directory.',
			'',
			'Guidelines:',
			'- Search for relevant files first using glob patterns, then read them',
			'- Use grep to search for specific code patterns or text',
			'- Always cite the source files in your answers',
			'- Be concise but thorough in your responses',
			'- If you cannot find the answer, say so clearly',
			'',
			'=== RESOURCE CONTEXT ===',
			agentInstructions,
			'=== END RESOURCE CONTEXT ===',
			'',
			'Question: ' + question
		].join('\n');

		return systemPrompt;
	}

	/**
	 * Extract tool name from a Cursor tool call event
	 * Handles all known Cursor tool types dynamically
	 */
	function getToolName(toolCall: CursorToolCall): string {
		// Check for known tool types by looking for *ToolCall keys
		const toolKeys = Object.keys(toolCall).filter((key) => key.endsWith('ToolCall'));
		if (toolKeys.length > 0 && toolKeys[0]) {
			// Extract tool name from key: "readToolCall" -> "read", "globToolCall" -> "glob"
			return toolKeys[0].replace('ToolCall', '');
		}
		if (toolCall.function) return toolCall.function.name;
		return 'unknown';
	}

	/**
	 * Extract tool input from a Cursor tool call event
	 */
	function getToolInput(toolCall: CursorToolCall): unknown {
		// Find the first *ToolCall key and extract its args
		const toolKeys = Object.keys(toolCall).filter((key) => key.endsWith('ToolCall'));
		if (toolKeys.length > 0 && toolKeys[0]) {
			const toolData = toolCall[toolKeys[0]] as { args?: Record<string, unknown> } | undefined;
			return toolData?.args ?? {};
		}
		if (toolCall.function) {
			try {
				return JSON.parse(toolCall.function.arguments);
			} catch {
				return toolCall.function.arguments;
			}
		}
		return {};
	}

	/**
	 * Extract tool output from a Cursor tool call completed event
	 */
	function getToolOutput(toolCall: CursorToolCall): string {
		// Find the first *ToolCall key and extract its result
		const toolKeys = Object.keys(toolCall).filter((key) => key.endsWith('ToolCall'));
		if (toolKeys.length > 0 && toolKeys[0]) {
			const toolData = toolCall[toolKeys[0]] as
				| {
						result?: { success?: Record<string, unknown> };
				  }
				| undefined;
			const result = toolData?.result?.success;
			if (result) {
				// Try to create a meaningful output string based on available fields
				if ('content' in result && typeof result.content === 'string') {
					return result.content;
				}
				if ('totalLines' in result) {
					return `Read ${result.totalLines} lines`;
				}
				if ('totalFiles' in result) {
					return `Found ${result.totalFiles} files`;
				}
				if ('linesCreated' in result && 'path' in result) {
					return `Wrote ${result.linesCreated} lines to ${result.path}`;
				}
				// Generic success message
				return JSON.stringify(result);
			}
		}
		return 'Tool completed';
	}

	/**
	 * Parse a line of NDJSON from Cursor CLI
	 */
	function parseJsonLine(line: string): CursorJsonEvent | null {
		const trimmed = line.trim();
		if (!trimmed) return null;

		try {
			return JSON.parse(trimmed) as CursorJsonEvent;
		} catch {
			return null;
		}
	}

	/**
	 * Convert a Cursor JSON event to AgentLoop events.
	 * With --stream-partial-output, each assistant event contains a delta (partial text),
	 * not the accumulated text. We emit it directly.
	 */
	function* convertEvent(event: CursorJsonEvent): Generator<CursorEvent> {
		switch (event.type) {
			case 'system':
				// init is handled separately via onInit
				break;

			case 'user':
				// User message - skip (we already know the question)
				break;

			case 'assistant': {
				// With --stream-partial-output, Cursor sends delta events as well as duplicate summaries.
				// We skip the pre-tool-call summaries (model_call_id present).
				const assistantEvent = event as CursorAssistantEvent;
				if (assistantEvent.model_call_id) break;

				for (const content of event.message.content) {
					if (content.type === 'text' && content.text) {
						yield { type: 'text-delta', text: content.text };
					}
				}
				break;
			}

			case 'tool_call':
				if (event.subtype === 'started') {
					yield {
						type: 'tool-call',
						toolName: getToolName(event.tool_call),
						input: getToolInput(event.tool_call)
					};
				} else if (event.subtype === 'completed') {
					yield {
						type: 'tool-result',
						toolName: getToolName(event.tool_call),
						output: getToolOutput(event.tool_call as CursorToolCallCompletedEvent['tool_call'])
					};
				}
				break;

			case 'result':
				yield {
					type: 'finish',
					finishReason: event.is_error ? 'error' : 'stop',
					usage: {
						// Cursor doesn't provide token usage in the same way
						inputTokens: undefined,
						outputTokens: undefined
					}
				};
				break;
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Main Functions
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * Run the Cursor CLI and stream events
	 */
	export async function* stream(options: Options): AsyncGenerator<CursorEvent> {
		const { collectionPath, question, agentInstructions, model, timeoutMs = 300_000 } = options;

		// Check if Cursor CLI is installed
		const installed = await isCursorInstalled();
		if (!installed) {
			yield {
				type: 'error',
				error: new Error(
					'Cursor CLI (agent) is not installed. Install it with: curl https://cursor.com/install -fsS | bash'
				)
			};
			return;
		}

		// Build the full prompt with system instructions and context
		const fullPrompt = buildFullPrompt(agentInstructions, question);

		// Build command args
		const args = [
			'agent',
			'-p',
			fullPrompt,
			'--mode=ask',
			'--output-format',
			'stream-json',
			'--stream-partial-output'
		];

		// Determine which model to use for Cursor CLI
		// Cursor models include: auto, sonnet-4.5, opus-4.5, gpt-5.2, gemini-3-*, grok, composer-1, etc.
		// OpenCode models like 'claude-haiku-4-5' should fallback to 'auto'
		const cursorModelPatterns = [
			/^auto$/,
			/^composer-/,
			/^gpt-/,
			/^sonnet-/,
			/^opus-/,
			/^gemini-/,
			/^grok$/
		];
		const isCursorModel = model && cursorModelPatterns.some((pattern) => pattern.test(model));
		const cursorModel = isCursorModel ? model : 'auto';
		args.push('--model', cursorModel);

		// Spawn the Cursor CLI in non-interactive ask mode with stream-json output
		const proc = Bun.spawn(args, {
			cwd: collectionPath,
			stdout: 'pipe',
			stderr: 'pipe'
		});

		// Set up timeout
		const timeoutId = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			// Stream stdout and parse NDJSON lines
			const reader = proc.stdout.getReader();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete lines
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newlineIndex);
					buffer = buffer.slice(newlineIndex + 1);

					const event = parseJsonLine(line);
					if (event) {
						if (event.type === 'system' && event.subtype === 'init') {
							options.onInit?.({ model: event.model });
						}

						// Convert and yield events
						for (const agentEvent of convertEvent(event)) {
							yield agentEvent;
						}
					}
				}
			}

			// Process any remaining buffer content
			if (buffer.trim()) {
				const event = parseJsonLine(buffer);
				if (event) {
					if (event.type === 'system' && event.subtype === 'init') {
						options.onInit?.({ model: event.model });
					}
					for (const agentEvent of convertEvent(event)) {
						yield agentEvent;
					}
				}
			}

			// Wait for process to complete
			const exitCode = await proc.exited;
			clearTimeout(timeoutId);

			if (exitCode !== 0) {
				// Read stderr for error message
				const stderrText = await new Response(proc.stderr).text();
				yield {
					type: 'error',
					error: new Error(
						`Cursor CLI exited with code ${exitCode}: ${stderrText || 'Unknown error'}`
					)
				};
			}
		} catch (err) {
			clearTimeout(timeoutId);
			yield {
				type: 'error',
				error: err instanceof Error ? err : new Error(String(err))
			};
		}
	}

	/**
	 * Run the Cursor CLI and return the complete result
	 */
	export async function run(options: Options): Promise<Result> {
		const events: CursorEvent[] = [];
		let answer = '';
		let modelName = 'cursor-agent';
		let initialized = false;

		for await (const event of stream({
			...options,
			onInit: (args) => {
				if (initialized) return;
				initialized = true;
				modelName = args.model;
				options.onInit?.(args);
			}
		})) {
			events.push(event);

			if (event.type === 'text-delta') {
				answer += event.text;
			} else if (event.type === 'error') {
				throw event.error;
			}
		}

		return {
			answer: answer.trim(),
			model: { provider: 'cursor', model: modelName },
			events
		};
	}
}
