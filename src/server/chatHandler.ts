import Anthropic from '@anthropic-ai/sdk';
import { checkCitations } from '../lib/citations';
import type { Embedder } from '../lib/embeddings';
import { UnauthorizedError, ValidationError } from '../lib/errors';
import type { hybridSearch, SearchResult } from '../lib/hybridSearch';
import { buildSystemPrompt, NO_CONTEXT_ANSWER } from '../lib/prompt';
import { SSE_HEADERS, sseEvent } from '../lib/sse';
import { assertTenantId } from '../lib/tenant';

const MAX_QUESTION_LENGTH = 2000;
const TOP_K = 8;

export interface ChatDeps {
  anthropic: Anthropic;
  embedder: Embedder;
  search: typeof hybridSearch;
  model: string;
}

interface ChatRequest {
  tenantId: string;
  question: string;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function parseBody(body: unknown): ChatRequest {
  const { tenantId, question } = (body ?? {}) as Record<string, unknown>;

  // Tenant check first: an unauthenticated caller shouldn't learn anything
  // about what else is wrong with the request.
  assertTenantId(tenantId);

  if (typeof question !== 'string' || question.trim() === '') {
    throw new ValidationError('question is required');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`question must be at most ${MAX_QUESTION_LENGTH} characters`);
  }
  return { tenantId, question: question.trim() };
}

function toSource(c: SearchResult) {
  return { chunkId: c.chunkId, documentId: c.documentId, filename: c.filename, page: c.pageNumber, score: c.score };
}

/**
 * POST /api/chat
 *
 * Body: { tenantId, question }
 * Response: text/event-stream with events
 *   sources -> chunks used for grounding
 *   delta   -> { text } answer tokens
 *   done    -> { stopReason, citations, unknownCitations }
 *   error   -> { message }
 *
 * NOTE: tenantId comes from the body because the brief asks for it. In
 * production it must come from the verified session / JWT instead.
 */
export function createChatHandler(getDeps: () => ChatDeps) {
  return async function POST(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, 'Request body must be JSON');
    }

    let input: ChatRequest;
    try {
      input = parseBody(body);
    } catch (err) {
      if (err instanceof UnauthorizedError) return jsonError(401, 'Unauthorized');
      if (err instanceof ValidationError) return jsonError(400, err.message);
      throw err;
    }

    const deps = getDeps();

    // Retrieval happens before we open the stream so failures surface as a
    // proper HTTP status instead of an error event.
    let chunks: SearchResult[];
    try {
      const embedding = await deps.embedder.embed(input.question);
      chunks = await deps.search(input.tenantId, embedding, TOP_K, { queryText: input.question });
    } catch (err) {
      console.error('retrieval failed', err);
      return jsonError(502, 'Retrieval failed');
    }

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: unknown) => controller.enqueue(sseEvent(event, data));
        send('sources', chunks.map(toSource));

        // Nothing relevant: don't spend a model call, and don't give the
        // model a chance to answer from general knowledge.
        if (chunks.length === 0) {
          send('delta', { text: NO_CONTEXT_ANSWER });
          send('done', { stopReason: 'no_context', citations: [], unknownCitations: [] });
          controller.close();
          return;
        }

        try {
          const answer = deps.anthropic.beta.messages.stream(
            {
              model: deps.model,
              max_tokens: 16000,
              // If a safety classifier declines, let the API retry on a
              // suitable fallback model rather than returning nothing.
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              output_config: { effort: 'medium' },
              system: buildSystemPrompt(chunks),
              messages: [{ role: 'user', content: input.question }],
            },
            { signal: req.signal },
          );

          let fullText = '';
          for await (const event of answer) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullText += event.delta.text;
              send('delta', { text: event.delta.text });
            }
          }

          const final = await answer.finalMessage();
          const { cited, unknown } = checkCitations(fullText, chunks);
          if (unknown.length > 0) {
            console.warn('model cited sources that were not retrieved', { tenantId: input.tenantId, unknown });
          }
          send('done', { stopReason: final.stop_reason, citations: cited, unknownCitations: unknown });
        } catch (err) {
          if (req.signal.aborted) return; // client went away, nothing to report
          console.error('generation failed', err);
          send('error', { message: 'Failed to generate an answer' });
        } finally {
          try {
            controller.close();
          } catch {
            // already closed/cancelled
          }
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}
