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

  // 1. Parcels
  const parcels = [];
  const lines = text.split(/\r?\n/);
  let currentReg = 'C';
  let inPartB = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('ČASŤ B: VLASTNÍCI') || line.includes('ČASŤ B: VLASTNICI')) inPartB = true;
    if (line.includes('ČASŤ A: MAJETKOVÁ PODSTATA')) inPartB = false;

    if (!inPartB) {
      if (/parcely registra\s*[„"]?E/i.test(line)) currentReg = 'E';
      if (/parcely registra\s*[„"]?C/i.test(line)) currentReg = 'C';

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

  // 2. Owners
  const owners = [];
  const partBText = text.split('ČASŤ B: VLASTNÍCI')[1]?.split('ČASŤ C: ŤARCHY')[0] || '';
  const ownerLines = partBText.split(/\r?\n/);

  let currentOwner = null;

  for (let i = 0; i < ownerLines.length; i++) {
    const line = ownerLines[i].trim();
    if (!line) continue;

    const m = line.match(/^(\d+)\t([^\t]+)(?:\t([^\t]+))?/)
      || line.match(/^(\d+)\s+(.+?)\s+(\d+)\s*\/\s*(\d+)\s*$/);
    if (m) {
      const poradove = parseInt(m[1], 10);
      const namePart = m[2];
      const podielPart = m[4] ? `${m[3]}/${m[4]}` : (m[3] || namePart);

      const fracMatch = podielPart.match(/(\d+)\/(\d+)/) || namePart.match(/(\d+)\/(\d+)/);
      const num = fracMatch ? parseInt(fracMatch[1], 10) : 1;
      const den = fracMatch ? parseInt(fracMatch[2], 10) : 1;

      const dobMatch = namePart.match(/Dátum narodenia\s*:\s*([\d\.-]+|-)/i);
      const dob = dobMatch ? dobMatch[1].trim() : '';

      const cleanName = namePart.replace(/,?\s*Dátum narodenia\s*:\s*[\d\.-]+/i, '').trim();

      if (currentOwner) owners.push(currentOwner);

      currentOwner = {
        lv, cislo_ku, poradove_cislo: poradove,
        meno_vlastnika: cleanName,
        datum_narodenia: dob,
        podiel_str: `${num}/${den}`,
        podiel_num: num, podiel_den: den, podiel_decimal: num / den,
        titul_nadobudnutia: ''
      };
    } else if (currentOwner && line.startsWith('Titul nadobudnutia:')) {
      let titulAcc = '';
      for (let j = i + 1; j < ownerLines.length; j++) {
        const nextLine = ownerLines[j].trim();
        if (nextLine.startsWith('Iné údaje') || nextLine.startsWith('Poznámky') || /^\d+\t/.test(nextLine)) break;
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
      pocet_parciel_c: parcels.filter(p => p.register_type === 'C').length,
      pocet_parciel_e: parcels.filter(p => p.register_type === 'E').length,
      celkova_vymera_m2: totalArea,
      pocet_vlastnikov: owners.length
    },
    parcels,
    owners
  };
}
