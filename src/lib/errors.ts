export type ErrorCode =
  | 'PROVIDER_DOWN'   // TopSAPI упал
  | 'INVALID_URL'     // не 1688 ссылка
  | 'RATE_LIMITED'    // слишком часто
  | 'LIMIT_REACHED'   // free лимит исчерпан
  | 'LLM_FALLBACK'    // LLM вернул мусор (не критично)
  | 'UNKNOWN';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    /** Текст, который бот отправляет пользователю */
    public readonly userMessage: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
