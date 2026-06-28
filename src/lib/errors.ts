export type ErrorCode =
  | 'PROVIDER_DOWN'   // TopSAPI/Elim/внешний парсер упал
  | 'INVALID_URL'     // не товарная ссылка
  | 'RATE_LIMITED'    // слишком часто
  | 'LIMIT_REACHED'   // free лимит исчерпан
  | 'LLM_FALLBACK'    // LLM вернул мусор (не критично)
  | 'VALIDATION_BLOCKED' // hard validator заблокировал небезопасный отчёт
  | 'UNKNOWN';

export class AppError extends Error {
  public readonly code: ErrorCode;
  /** Текст, который бот отправляет пользователю */
  public readonly userMessage: string;
  public readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, userMessage: string, cause?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.cause = cause;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: string }).name === 'AppError' &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { userMessage?: unknown }).userMessage === 'string'
  );
}

export function toUserMessage(
  error: unknown,
  fallback = '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз.\nКредит не списан.'
): string {
  if (isAppError(error)) return error.userMessage;
  return fallback;
}
