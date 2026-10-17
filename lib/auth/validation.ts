export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export function normalizeNickname(nickname: string) { return nickname.trim().normalize('NFKC').toLowerCase(); }
export function validateSignup(nickname: unknown, password: unknown): string | null {
  if (typeof nickname !== 'string' || typeof password !== 'string') return 'Enter a nickname and password.';
  const name = nickname.trim().normalize('NFKC');
  if (name.length < 2 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return 'Use a nickname of 2 to 40 characters without control characters.';
  if (password.length < 8 || new TextEncoder().encode(password).byteLength > 72 || password.includes('\0')) return 'Use a password of at least 8 characters and no more than 72 UTF-8 bytes.';
  return null;
}
export function validSigninInput(nickname: unknown, password: unknown): nickname is string {
  return typeof nickname === 'string' && nickname.length > 0 && nickname.length <= 100 &&
    typeof password === 'string' && password.length > 0 && password.length <= 1024 && !password.includes('\0');
}
