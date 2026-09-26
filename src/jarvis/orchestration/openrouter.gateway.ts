import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface JarvisLlmPlanResponse {
  goal: string;
  agent: string;
  steps: Array<{
    toolId: string;
    intent: string;
    arguments?: Record<string, unknown>;
  }>;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  model?: string;
  error?: {
    code?: string | number;
    message?: string;
  };
}

@Injectable()
export class OpenRouterGateway {
  private readonly apiKey = process.env.OPENROUTER_API_KEY?.trim();
  private readonly primaryModel =
    process.env.OPENROUTER_MODEL?.trim() || 'google/gemini-3.8-flash';
  private readonly fallbackModels = (process.env.OPENROUTER_FALLBACK_MODELS?.trim() ||
    'openai/gpt-5-mini,anthropic/claude-sonnet-4.5')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  async generatePlan(
    systemInstruction: string,
    message: string,
  ): Promise<JarvisLlmPlanResponse> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'JARVIS OpenRouter gateway is not configured. Set OPENROUTER_API_KEY on the JARVIS backend.',
      );
    }

    const models = [this.primaryModel, ...this.fallbackModels.filter((model) => model !== this.primaryModel)];

    let response: Response | undefined;
    let lastDetail = '';

    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL?.trim() || 'https://stackaura.co.za',
          'X-Title': 'Stackaura J.A.R.V.I.S.',
        },
        body: JSON.stringify({
          model: models[0],
          models,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: message },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ServiceUnavailableException(
          'JARVIS OpenRouter planner timed out after 20 seconds.',
        );
      }
      throw error;
    }

    if (!response.ok) {
      lastDetail = await response.text().catch(() => '');
      const detail = this.extractErrorDetail(lastDetail);
      throw new ServiceUnavailableException(
        `JARVIS OpenRouter request failed with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
      );
    }

    const payload = (await response.json()) as OpenRouterResponse;
    const rawContent = payload.choices?.[0]?.message?.content;
    const text = Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? '').join('').trim()
      : rawContent?.trim();

    if (!text) {
      throw new ServiceUnavailableException(
        `JARVIS OpenRouter returned an empty planning response${payload.model ? ` from ${payload.model}` : ''}.`,
      );
    }

    try {
      return JSON.parse(text) as JarvisLlmPlanResponse;
    } catch {
      throw new ServiceUnavailableException(
        'JARVIS OpenRouter returned invalid planning JSON.',
      );
    }
  }

  private extractErrorDetail(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as OpenRouterResponse;
      return parsed.error?.message || raw;
    } catch {
      return raw;
    }
  }
}
