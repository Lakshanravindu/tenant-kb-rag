import Anthropic from '@anthropic-ai/sdk';
import { OpenAIEmbedder } from '../../../src/lib/embeddings';
import { hybridSearch } from '../../../src/lib/hybridSearch';
import { createChatHandler, type ChatDeps } from '../../../src/server/chatHandler';

export const runtime = 'nodejs'; // pg needs Node, not the edge runtime
export const dynamic = 'force-dynamic';

let deps: ChatDeps | undefined;

// Built lazily so `next build` doesn't need API keys.
function getDeps(): ChatDeps {
  deps ??= {
    anthropic: new Anthropic(),
    embedder: new OpenAIEmbedder(),
    search: hybridSearch,
    model: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
  };
  return deps;
}

export const POST = createChatHandler(getDeps);
