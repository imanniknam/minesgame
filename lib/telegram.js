import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_S = 24 * 3600;

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken, now = Date.now() / 1000) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheck = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheck).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now - authDate > MAX_AGE_S) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) ? { user, startParam: params.get('start_param') } : null;
  } catch { return null; }
}
