function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html) {
  return decodeEntities(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|h[1-6]|li|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function parseArea(raw) {
  if (raw == null) return 0;
  const n = parseFloat(String(raw).replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function looksLikeParcelNo(s) {
  return /^\d+[\/\d]*$/.test(String(s || '').trim());
}

const SK_FOLD = {
  á: 'a', ä: 'a', č: 'c', ď: 'd', é: 'e', í: 'i', ĺ: 'l', ľ: 'l',
  ň: 'n', ó: 'o', ô: 'o', ŕ: 'r', š: 's', ť: 't', ú: 'u', ý: 'y', ž: 'z',
  ě: 'e', ů: 'u', ł: 'l', ą: 'a', ę: 'e',
};

export function foldName(s) {
  return String(s || '')
    .replace(/[áäčďéěíĺľłňóôŕšťúůýžąę]/gi, (ch) => SK_FOLD[ch.toLowerCase()] || ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const DROP_TOKENS = new Set([
  'r', 'ico', 'psc', 'sr', 'ing', 'judr', 'mudr', 'phdr', 'rndr', 'paeddr',
  'thdr', 'bc', 'mgr', 'mvdr', 'prom', 'mba', 'phd', 'llc', 'c', 'ul', 'nam',
  'namestie', 'ulica', 'cislo', 'datum', 'narodenia', 'spf',
]);

export function ownerNameTokens(s) {
  let t = foldName(s);
  t = t.replace(/ico\s*:?\s*\d+/g, ' ');
  t = t.replace(/datum narodenia\s*:?\s*[\d./-]+/g, ' ');
  t = t.replace(/\bpsc\b[^a-z]*/g, ' ');
  t = t.replace(/\d+/g, ' ');
  return t.split(/[^a-z]+/).filter((tok) => tok.length >= 2 && !DROP_TOKENS.has(tok));
}

function extractDobIco(namePart, extra = '') {
  const blob = `${namePart} ${extra}`;
  const dobMatch = blob.match(/Dátum narodenia\s*:\s*([\d./-]+|-)/i);
  const icoMatch = blob.match(/IČO\s*:\s*(\d+)/i);
  const dob = dobMatch ? dobMatch[1].trim() : '';
  const ico = icoMatch ? icoMatch[1].trim() : '';
  let cleanName = String(namePart || '')
    .replace(/,?\s*Dátum narodenia\s*:\s*[\d./-]+/ig, '')
    .replace(/,?\s*IČO\s*:\s*\d+/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep IČO in the stored name when it was the identifying field (legal entity),
  // matching already-fetched parquet rows.
  if (ico && !/IČO\s*:/i.test(cleanName) && !dob) {
    cleanName = `${cleanName}${cleanName ? ', ' : ''}IČO: ${ico}`;
  }
  return { dob, ico, cleanName };
}

function parseOwnerFromParts(parts, lv, cislo_ku) {
  if (!parts.length || !/^\d+$/.test(parts[0])) return null;
  const poradove = parseInt(parts[0], 10);
  if (!poradove) return null;

  let podielIdx = -1;
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^\d+\s*\/\s*\d+$/.test(parts[i])) {
      podielIdx = i;
      break;
    }
  }
  const rest = parts.slice(1, podielIdx >= 0 ? podielIdx : parts.length);
  if (!rest.length && podielIdx < 0) return null;

  const namePart = rest[0] || '';
  const extra = rest.slice(1).join(' ');
  const podielPart = podielIdx >= 0 ? parts[podielIdx] : `${namePart} ${extra}`;
  const fracMatch = podielPart.match(/(\d+)\s*\/\s*(\d+)/) || `${namePart} ${extra}`.match(/(\d+)\s*\/\s*(\d+)/);
  if (!fracMatch) return null;

  const num = parseInt(fracMatch[1], 10);
  const den = parseInt(fracMatch[2], 10);
  if (!den) return null;

  const { dob, ico, cleanName } = extractDobIco(namePart, extra);
  if (!cleanName || /poradov|vlastn[ií]k|titul, meno/i.test(cleanName)) return null;

  return {
    lv,
    cislo_ku,
    poradove_cislo: poradove,
    meno_vlastnika: cleanName,
    datum_narodenia: dob || (ico ? `IČO ${ico}` : ''),
    ico,
    podiel_str: `${num}/${den}`,
    podiel_num: num,
    podiel_den: den,
    podiel_decimal: num / den,
    titul_nadobudnutia: '',
  };
}

export function looksLikeVypis(raw) {
  const s = String(raw || '');
  return /VÝPIS Z LISTU VLASTNÍCTVA|MAJETKOVÁ PODSTATA|Parcely registra|ČASŤ B:\s*VLASTNÍCI/i.test(s);
}

export function parseVypisInput(raw, defaultLv = 0, defaultKuCode = 0) {
  const s = String(raw || '').trim();
  if (!s) return parseLvText('', defaultLv, defaultKuCode);
  if (/<[a-z][\s\S]*>/i.test(s)) return parseLvHtml(s, defaultLv, defaultKuCode);
  return parseLvText(s, defaultLv, defaultKuCode);
}

export function parseLvHtml(html, defaultLv = 0, defaultKuCode = 0) {
  return parseLvText(htmlToText(html), defaultLv, defaultKuCode);
}

export function parseLvText(text, defaultLv = 0, defaultKuCode = 0) {
  const okresMatch = text.match(/Okres\s*:\s*\d*\s*([^\t\n\r]+)/i);
  const obecMatch = text.match(/Obec\s*:\s*\d*\s*([^\t\n\r]+)/i);
  const kuMatch = text.match(/Katastrálne územie\s*:\s*(\d+)\s*([^\t\n\r]+)/i);
  const lvMatch = text.match(/VÝPIS Z LISTU VLASTNÍCTVA č\.\s*(\d+)/i);

  const okres = okresMatch ? okresMatch[1].trim() : '';
  const obec = obecMatch ? obecMatch[1].trim() : '';
  const cislo_ku = kuMatch ? parseInt(kuMatch[1], 10) : defaultKuCode;
  const nazov_ku = kuMatch ? kuMatch[2].trim() : '';
  const lv = lvMatch ? parseInt(lvMatch[1], 10) : defaultLv;

  const parcels = [];
  const lines = text.split(/\r?\n/);
  let currentReg = 'C';
  let inPartB = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/ČASŤ B:\s*VLASTNÍCI/i.test(line) || /ČASŤ B:\s*VLASTNICI/i.test(line)) inPartB = true;
    if (/ČASŤ A:\s*MAJETKOVÁ PODSTATA/i.test(line)) inPartB = false;

    if (!inPartB) {
      if (/parcely registra\s*[„"”]?E/i.test(line)) currentReg = 'E';
      if (/parcely registra\s*[„"”]?C/i.test(line)) currentReg = 'C';

      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2 && looksLikeParcelNo(parts[0])) {
        const vymera = parseArea(parts[1]);
        if (vymera > 0) {
          parcels.push({
            lv, cislo_ku, register_type: currentReg,
            parcel_no: parts[0], vymera_m2: vymera, druh_pozemku: parts[2] || '',
          });
          continue;
        }
      }
      const spaced = line.match(/^(\d+(?:\/\d+)?)\s+(\d[\d\s]{0,14}(?:[.,]\d+)?)\s+(.{3,80})$/);
      if (spaced) {
        const vymera = parseArea(spaced[2]);
        if (vymera > 0) {
          parcels.push({
            lv, cislo_ku, register_type: currentReg,
            parcel_no: spaced[1], vymera_m2: vymera, druh_pozemku: spaced[3].trim(),
          });
        }
      }
    }
  }

  const owners = [];
  const partBText = text.split(/ČASŤ B:\s*VLASTNÍCI/i)[1]?.split(/ČASŤ C:/i)[0]
    || text.split(/ČASŤ B:\s*VLASTNICI/i)[1]?.split(/ČASŤ C:/i)[0]
    || '';
  const ownerLines = partBText.split(/\r?\n/);

  let currentOwner = null;

  for (let i = 0; i < ownerLines.length; i++) {
    const line = ownerLines[i].trim();
    if (!line) continue;
    if (/^poradov/i.test(line) && /podiel/i.test(line)) continue;

    const tabParts = line.split('\t').map((p) => p.trim()).filter(Boolean);
    let parsed = parseOwnerFromParts(tabParts, lv, cislo_ku);
    if (!parsed) {
      const m = line.match(/^(\d+)\s+(.+?)\s+(\d+)\s*\/\s*(\d+)\s*$/);
      if (m) parsed = parseOwnerFromParts([m[1], m[2], `${m[3]}/${m[4]}`], lv, cislo_ku);
    }

    if (parsed) {
      if (currentOwner) owners.push(currentOwner);
      currentOwner = parsed;
    } else if (currentOwner && /^Titul nadobudnutia:/i.test(line)) {
      let titulAcc = '';
      for (let j = i + 1; j < ownerLines.length; j++) {
        const nextLine = ownerLines[j].trim();
        if (nextLine.startsWith('Iné údaje') || nextLine.startsWith('Poznámky') || /^\d+\t/.test(nextLine) || /^\d+\s/.test(nextLine)) break;
        if (nextLine) titulAcc += (titulAcc ? ' ' : '') + nextLine;
      }
      currentOwner.titul_nadobudnutia = titulAcc;
    }
  }
  if (currentOwner) owners.push(currentOwner);

  const totalArea = parcels.reduce((s, p) => s + p.vymera_m2, 0);

  return {
    doc: {
      lv, cislo_ku, nazov_ku, okres, obec,
      pocet_parciel_c: parcels.filter((p) => p.register_type === 'C').length,
      pocet_parciel_e: parcels.filter((p) => p.register_type === 'E').length,
      celkova_vymera_m2: totalArea,
      pocet_vlastnikov: owners.length,
    },
    parcels,
    owners,
  };
}

export function matchOwners(owners, searchName) {
  const want = ownerNameTokens(searchName);
  if (!want.length) return [];
  const scored = [];
  for (const o of owners || []) {
    const have = ownerNameTokens(o.meno_vlastnika);
    if (!have.length) continue;
    const hits = want.filter((t) => have.includes(t)).length;
    if (hits < want.length) continue;
    scored.push({
      owner: o,
      extra: Math.max(0, have.length - want.length),
      hits,
    });
  }
  if (!scored.length) return [];
  const bestHits = Math.max(...scored.map((s) => s.hits));
  const top = scored.filter((s) => s.hits === bestHits);
  const minExtra = Math.min(...top.map((s) => s.extra));
  return top.filter((s) => s.extra === minExtra).map((s) => s.owner);
}

export function personParcelBreakdown(parsed, searchName) {
  const parcels = parsed?.parcels || [];
  const owners = parsed?.owners || [];
  const matches = matchOwners(owners, searchName);
  const lvTotal = parcels.reduce((s, p) => s + (Number(p.vymera_m2) || 0), 0);
  const podielDecimal = matches.reduce((s, o) => s + (Number(o.podiel_decimal) || 0), 0);
  const podielStr = matches.map((o) => o.podiel_str).filter(Boolean).join(' + ') || '';
  const rows = parcels.map((p) => {
    const vymera = Number(p.vymera_m2) || 0;
    const ich = matches.length ? vymera * podielDecimal : 0;
    return {
      register_type: p.register_type || '',
      parcel_no: p.parcel_no || '',
      vymera_m2: vymera,
      druh_pozemku: p.druh_pozemku || '',
      podiel_str: podielStr,
      podiel_decimal: podielDecimal,
      ich_m2: ich,
    };
  });
  const ichTotal = rows.reduce((s, r) => s + r.ich_m2, 0);
  return {
    matches,
    onLv: matches.length > 0,
    podiel_str: podielStr,
    podiel_decimal: podielDecimal,
    parcels: rows,
    ichTotal,
    lvTotal,
  };
}
