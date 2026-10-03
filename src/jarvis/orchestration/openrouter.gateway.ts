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
  private readonly fallbackModels = (
    process.env.OPENROUTER_FALLBACK_MODELS?.trim() ||
    'openai/gpt-5-mini,anthropic/claude-sonnet-4.5'
  )
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

    const models = [
      this.primaryModel,
      ...this.fallbackModels.filter((model) => model !== this.primaryModel),
    ];
    const failures: string[] = [];

    for (const model of models) {
      try {
        return await this.requestModel(model, systemInstruction, message);
      } catch (error) {
        const detail =
          error instanceof ServiceUnavailableException
            ? error.message
            : error instanceof Error
              ? error.message
              : 'unknown planner failure';
        failures.push(model + ': ' + detail.slice(0, 180));
      }
    }

    throw new ServiceUnavailableException(
      'JARVIS OpenRouter planner exhausted its model chain. ' +
        failures.join(' | '),
    );
  }

  private async requestModel(
    model: string,
    systemInstruction: string,
    message: string,
  ): Promise<JarvisLlmPlanResponse> {
    let response: Response;

    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL?.trim() || 'https://stackaura.co.za',
          'X-Title': 'Stackaura J.A.R.V.I.S.',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: message },
          ],
          reasoning: { enabled: false },
          response_format: { type: 'json_object' },
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(6500),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ServiceUnavailableException(
          'JARVIS OpenRouter model ' + model + ' timed out after 6.5 seconds.',
        );
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const detail = this.extractErrorDetail(raw);
      throw new ServiceUnavailableException(
        'JARVIS OpenRouter model ' +
          model +
          ' failed with status ' +
          response.status +
          (detail ? ': ' + detail.slice(0, 300) : '.'),
      );
    }

    const payload = (await response.json()) as OpenRouterResponse;
    const rawContent = payload.choices?.[0]?.message?.content;
    const text = Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? '').join('').trim()
      : rawContent?.trim();

    if (!text) {
      throw new ServiceUnavailableException(
        'JARVIS OpenRouter model ' +
          model +
          ' returned an empty planning response.',
      );
    }

    try {
      return JSON.parse(text) as JarvisLlmPlanResponse;
    } catch {
      throw new ServiceUnavailableException(
        'JARVIS OpenRouter model ' +
          model +
          ' returned invalid planning JSON.',
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
