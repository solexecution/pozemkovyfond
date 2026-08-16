/** True when HTML is the cadastral extract, not the reCAPTCHA interstitial. */
export function isLvVypisHtml(html) {
  const s = String(html || '');
  if (s.length < 400) return false;
  const hasDoc = /VÝPIS Z LISTU VLASTNÍCTVA|MAJETKOVÁ PODSTATA|Parcely registra/i.test(s);
  if (!hasDoc) return false;
  if (/g-recaptcha|captchaIsReady/i.test(s) && !/MAJETKOVÁ PODSTATA/i.test(s)) return false;
  return true;
}
