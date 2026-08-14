# Pozemkový fond — PZF Explorer

Analytický dashboard pre register **neznámych vlastníkov** a **prevedených práv** Slovenského pozemkového fondu.

Beží celý v prehliadači cez **DuckDB WASM** (žiadny backend).

## Live

https://solexecution.github.io/pozemkovyfond/

## Lokálne

```bash
npm start
```

Otvor [http://localhost:3000](http://localhost:3000). Prvé načítanie stiahne `data/unknown_owners.parquet` (~51 MB).

## Dáta

| Súbor | Obsah |
| --- | --- |
| `data/unknown_owners.parquet` | 4,9 mil. záznamov neznámych vlastníkov (stav k 30.06.2026) |
| `data/transferred_rights.parquet` | Prevedené práva 2022–2025 |
| `data/lv_*.parquet` | Uložené výpisy z LV |
| `sk_boundaries.json` | Hranice obcí SR pre mapu |

Zdrojové CSV / XLSX a natívna `pzf.duckdb` sa do gitu necommitujú (sú príliš veľké). Rebuild:

```bash
npm run build        # CSV + XLSX → pzf.duckdb
npm run build-data   # DuckDB → parquet pre GitHub Pages
```

Pôvodný Express + Node DuckDB server ostáva v `server.js` pre lokálny vývoj s plnou databázou.
