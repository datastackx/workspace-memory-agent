import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Logger } from "./logger.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16_000;
const EFFORT = "medium";
// Server-side fallback: if the model declines for policy reasons, the API retries
// on Anthropic's recommended substitute inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type TurnRequest = {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
};

/**
 * Everything the app needs from a model. The agent loop and extraction depend on
 * this interface, not on the SDK, so tests run against a scripted fake.
 */
export interface ModelGateway {
  runTurn(request: TurnRequest): Promise<Anthropic.Beta.BetaMessage>;
  extract<T>(request: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
}

export class ModelRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}.`);
  }
}

export class ClaudeGateway implements ModelGateway {
  private readonly client = new Anthropic();

  constructor(
    private readonly logger: Logger,
    private readonly model = process.env.AGENT_MODEL ?? DEFAULT_MODEL,
  ) {}

  async runTurn({ system, tools, messages }: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT },
      // Tools render before system, so one breakpoint here caches both: the stable prefix.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    this.logUsage("model.turn", response);
    return response;
  }

  async extract<T>({ system, user, schema }: { system: string; user: string; schema: z.ZodType<T> }): Promise<T> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: betaZodOutputFormat(schema) },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    this.logUsage("model.extract", response);
    if (response.stop_reason === "refusal") {
      throw new ModelRefusalError(response.stop_details?.category ?? null);
    }
    if (!response.parsed_output) {
      throw new Error(`Extraction returned no parseable output (stop_reason=${response.stop_reason}).`);
    }
    return response.parsed_output as T;
  }

  private logUsage(event: string, response: Anthropic.Beta.BetaMessage): void {
    this.logger.info(event, {
      model: response.model,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens,
    });
  }
}
