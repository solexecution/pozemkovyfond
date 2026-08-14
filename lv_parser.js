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
  let inPartA = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('ČASŤ A: MAJETKOVÁ PODSTATA')) inPartA = true;
    if (line.includes('ČASŤ B: VLASTNÍCI')) inPartA = false;

    if (inPartA) {
      if (line.includes('Parcely registra „E"')) currentReg = 'E';
      if (line.includes('Parcely registra „C"')) currentReg = 'C';

      const parts = line.split('\t');
      if (parts.length >= 3 && /^\d+[\/\d]*$/.test(parts[0])) {
        const vymera = parseFloat(parts[1].replace(/\s+/g, '').replace(',', '.')) || 0;
        parcels.push({
          lv, cislo_ku, register_type: currentReg,
          parcel_no: parts[0], vymera_m2: vymera, druh_pozemku: parts[2]
        });
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

    const m = line.match(/^(\d+)\t([^\t]+)(?:\t([^\t]+))?/);
    if (m) {
      const poradove = parseInt(m[1], 10);
      const namePart = m[2];
      const podielPart = m[3] || namePart;

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
