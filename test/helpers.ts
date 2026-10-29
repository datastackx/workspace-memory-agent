import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { openDb, type Db } from "../src/db/db.js";
import type { ModelGateway, TurnRequest } from "../src/llm.js";
import { newScope, type Scope } from "../src/scope.js";
import { seed } from "../src/seed.js";

export async function testDb(): Promise<Db> {
  const db = await openDb({ inMemory: true });
  await seed(db);
  return db;
}

export const scopes = {
  maya: (): Scope => newScope("northwind", "maya"),
  arjun: (): Scope => newScope("northwind", "arjun"),
  lee: (): Scope => newScope("globex", "lee"),
};

type Block = Anthropic.Beta.BetaContentBlock;

export function toolUse(id: string, name: string, input: Record<string, unknown>): Block {
  return { type: "tool_use", id, name, input } as Block;
}

export function text(value: string): Block {
  return { type: "text", text: value, citations: null } as Block;
}

export function message(content: Block[], stopReason: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "fake-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** A scripted model: returns queued turns in order and records every request it saw. */
export class FakeGateway implements ModelGateway {
  readonly turnRequests: TurnRequest[] = [];
  readonly extractRequests: Array<{ system: string; user: string }> = [];

  constructor(
    private readonly turns: Array<Anthropic.Beta.BetaMessage | ((req: TurnRequest) => Anthropic.Beta.BetaMessage)> = [],
    private readonly extraction: unknown = { summary: "", items: [] },
  ) {}

  async runTurn(request: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
    // Snapshot the messages: the loop keeps appending to the same array.
    this.turnRequests.push({ ...request, messages: structuredClone(request.messages) });
    const next = this.turns.shift();
    if (!next) throw new Error("FakeGateway ran out of scripted turns");
    return typeof next === "function" ? next(request) : next;
  }

  async extract<T>({ system, user, schema }: { system: string; user: string; schema: z.ZodType<T> }): Promise<T> {
    this.extractRequests.push({ system, user });
    return schema.parse(this.extraction);
  }
}
