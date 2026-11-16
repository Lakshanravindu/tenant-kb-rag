import type { SearchResult } from '../src/lib/hybridSearch';
import { NO_CONTEXT_ANSWER } from '../src/lib/prompt';
import { createChatHandler, type ChatDeps } from '../src/server/chatHandler';
import { embedding, TENANT_A } from './helpers/fakePool';

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    chunkId: 'c1',
    documentId: 'd1',
    filename: 'handbook.pdf',
    pageNumber: 4,
    chunkIndex: 0,
    content: 'Employees get 25 days of annual leave.',
    score: 0.03,
    vectorRank: 1,
    keywordRank: 1,
    ...overrides,
  };
}

/** Fake of the SDK's MessageStream: async-iterable events + finalMessage(). */
function fakeClaudeStream(chunks: string[], stopReason = 'end_turn') {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      }
    },
    finalMessage: async () => ({ stop_reason: stopReason }),
  };
}

function setup(opts: { results?: SearchResult[]; answer?: string[] } = {}) {
  const deps = {
    anthropic: { beta: { messages: { stream: jest.fn(() => fakeClaudeStream(opts.answer ?? [])) } } },
    embedder: { embed: jest.fn(async () => embedding()) },
    search: jest.fn(async () => opts.results ?? []),
    model: 'test-model',
  };
  return { deps, handler: createChatHandler(() => deps as unknown as ChatDeps) };
}

function post(body: unknown) {
  return new Request('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body) });
}

async function readEvents(res: Response) {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
      return { event, data };
    });
}

describe('POST /api/chat', () => {
  it('streams a grounded answer as SSE with sources, deltas and validated citations', async () => {
    const { deps, handler } = setup({
      results: [result({})],
      answer: ['You get 25 days ', 'of annual leave (Doc: handbook.pdf, p.4).'],
    });

    const res = await handler(post({ tenantId: TENANT_A, question: ' How much leave do I get? ' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await readEvents(res);
    expect(events.map((e) => e.event)).toEqual(['sources', 'delta', 'delta', 'done']);
    expect(events[0]!.data).toEqual([{ chunkId: 'c1', documentId: 'd1', filename: 'handbook.pdf', page: 4, score: 0.03 }]);
    expect(events.at(-1)!.data).toEqual({
      stopReason: 'end_turn',
      citations: [{ filename: 'handbook.pdf', page: 4 }],
      unknownCitations: [],
    });

    expect(deps.search).toHaveBeenCalledWith(TENANT_A, expect.any(Array), 8, { queryText: 'How much leave do I get?' });

    const params = (deps.anthropic.beta.messages.stream.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(params.model).toBe('test-model');
    expect(params.system).toContain('<source id="1" filename="handbook.pdf" page="4">');
    expect(params.system).toContain('(Doc: <filename>, p.<page>)');
    expect(params.messages).toEqual([{ role: 'user', content: 'How much leave do I get?' }]);
  });

  it('flags citations that do not match any retrieved chunk', async () => {
    const { handler } = setup({
      results: [result({})],
      answer: ['Yes (Doc: handbook.pdf, p.4) and also (Doc: secret.pdf, p.1).'],
    });

    const events = await readEvents(await handler(post({ tenantId: TENANT_A, question: 'q' })));

    expect(events.at(-1)!.data.unknownCitations).toEqual([{ filename: 'secret.pdf', page: 1 }]);
  });

  it('answers "not found" without calling Claude when retrieval returns nothing', async () => {
    const { deps, handler } = setup({ results: [] });

    const events = await readEvents(await handler(post({ tenantId: TENANT_A, question: 'q' })));

    expect(deps.anthropic.beta.messages.stream).not.toHaveBeenCalled();
    expect(events.find((e) => e.event === 'delta')!.data.text).toBe(NO_CONTEXT_ANSWER);
    expect(events.at(-1)!.data.stopReason).toBe('no_context');
  });

  it('returns 400 for a missing question', async () => {
    const { handler } = setup();
    expect((await handler(post({ tenantId: TENANT_A }))).status).toBe(400);
  });

  it('returns 400 for a non-JSON body', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://localhost/api/chat', { method: 'POST', body: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('returns 502 when retrieval fails', async () => {
    const { deps, handler } = setup();
    deps.search.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await handler(post({ tenantId: TENANT_A, question: 'q' }));

    expect(res.status).toBe(502);
  });

  it('emits an error event if generation fails mid-stream', async () => {
    const { deps, handler } = setup({ results: [result({})] });
    deps.anthropic.beta.messages.stream.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
        throw new Error('overloaded');
      },
      finalMessage: async () => ({ stop_reason: 'end_turn' }),
    }) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const events = await readEvents(await handler(post({ tenantId: TENANT_A, question: 'q' })));

    expect(events.map((e) => e.event)).toEqual(['sources', 'delta', 'error']);
  });
});
