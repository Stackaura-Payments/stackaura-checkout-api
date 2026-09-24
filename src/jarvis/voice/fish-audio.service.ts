import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const DEFAULT_MODEL = 's2.1-pro';
const DEFAULT_VOICE_ID = '686905bc7bca40829e6ccf0971948b5f';

@Injectable()
export class FishAudioService {
  private readonly apiKey = process.env.FISH_AUDIO_API_KEY?.trim();
  private readonly voiceId =
    process.env.FISH_AUDIO_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  private readonly model =
    process.env.FISH_AUDIO_MODEL?.trim() || DEFAULT_MODEL;

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.voiceId);
  }

  async streamSpeech(text: string): Promise<Response> {
    const normalized = text.trim();

    if (!normalized) {
      throw new BadRequestException('Speech text is required.');
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Fish Audio is not configured on the JARVIS backend.',
      );
    }

    const response = await fetch(FISH_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.apiKey,
        'Content-Type': 'application/json',
        model: this.model,
      },
      body: JSON.stringify({
        text: normalized,
        reference_id: this.voiceId,
        format: 'mp3',
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new ServiceUnavailableException(
        detail || `Fish Audio TTS failed with status ${response.status}.`,
      );
    }

    return response;
  }
}
