const SONIOX_MODELS_URL = 'https://api.soniox.com/v1/tts-models';

export interface VoiceOption {
  id: string;
  gender: string;
  description: string;
}

interface SonioxModelsResponse {
  models?: Array<{
    id: string;
    aliased_model_id?: string | null;
    voices?: Array<{ id: string; description?: string; gender?: string }>;
  }>;
}

/**
 * Soniox publishes its voice catalog per model, not in the docs, so Kato asks
 * the API. Every voice speaks all supported languages, so this is a matter of
 * taste rather than of picking a "Spanish" voice.
 */
export async function listSonioxVoices(apiKey: string, model: string): Promise<VoiceOption[]> {
  const response = await fetch(SONIOX_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Soniox ${response.status}: ${(await response.text().catch(() => '')).slice(0, 160)}`);
  }
  const body = (await response.json()) as SonioxModelsResponse;
  const models = body.models ?? [];
  const match =
    models.find((m) => m.id === model || m.aliased_model_id === model) ?? models[models.length - 1];
  return (match?.voices ?? []).map((voice) => ({
    id: voice.id,
    gender: voice.gender ?? '',
    description: voice.description ?? '',
  }));
}

/** OpenAI's catalog is fixed and undocumented per-account, so it's a constant. */
export const OPENAI_VOICES: VoiceOption[] = [
  { id: 'alloy', gender: 'neutral', description: 'Balanced, neutral.' },
  { id: 'ash', gender: 'male', description: 'Warm, conversational.' },
  { id: 'ballad', gender: 'male', description: 'Soft, expressive.' },
  { id: 'coral', gender: 'female', description: 'Bright, friendly.' },
  { id: 'echo', gender: 'male', description: 'Calm, even.' },
  { id: 'fable', gender: 'neutral', description: 'Storytelling tone.' },
  { id: 'onyx', gender: 'male', description: 'Deep, authoritative.' },
  { id: 'nova', gender: 'female', description: 'Energetic, quick.' },
  { id: 'sage', gender: 'female', description: 'Measured, gentle.' },
  { id: 'shimmer', gender: 'female', description: 'Light, airy.' },
  { id: 'verse', gender: 'male', description: 'Expressive, dynamic.' },
];
