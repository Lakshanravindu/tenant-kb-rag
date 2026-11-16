import OpenAI from 'openai';
import { EMBEDDING_DIMENSIONS } from './hybridSearch';

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * Claude doesn't expose an embeddings endpoint, so query embeddings come from a
 * separate provider. It must be the same model that was used at ingestion time.
 */
export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly client = new OpenAI(),
    private readonly model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vector = res.data[0]?.embedding;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding provider returned an unexpected vector size`);
    }
    return vector;
  }
}
