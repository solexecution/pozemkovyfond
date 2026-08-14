// parse_bo_html.cjs
// Node script (CommonJS) to parse the BO HTML fetched by fetch_bo_html.cjs
// Usage: node parse_bo_html.cjs <htmlFile>
// Example: node parse_bo_html.cjs bo_1208_859559.html

const fs = require('fs');
const cheerio = require('cheerio');

const [,, htmlPath] = process.argv;
if (!htmlPath) {
  console.error('Usage: node parse_bo_html.cjs <htmlFile>');
  process.exit(1);
}

// Read HTML file
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

// Find the table that contains owner information. Heuristic: look for a table with a header containing 'Vlastník'
let targetTable = null;
$('table').each((i, table) => {
  const headers = $(table).find('th').map((i, th) => $(th).text().trim()).get();
  if (headers.some(h => /Vlastník/i.test(h))) {
    targetTable = table;
    return false; // break loop
  }
});

if (!targetTable) {
  console.error('Could not find owner table in HTML.');
  process.exit(1);
}

// Extract rows
const rows = [];
$(targetTable).find('tr').each((i, tr) => {
  const cols = $(tr).find('td, th').map((i, cell) => {
    // Replace newlines and excessive whitespace inside cell
    return $(cell).text().replace(/\s+/g, ' ').trim();
  }).get();
  // Skip empty rows
  if (cols.length && cols.some(c => c !== '')) {
    rows.push(cols);
  }
});

if (rows.length === 0) {
  console.error('No data rows found in the table.');
  process.exit(1);
}

// Convert rows to CSV (comma separated, proper escaping)
function escapeCsv(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
const csvLines = rows.map(row => row.map(escapeCsv).join(','));
const csvContent = csvLines.join('\n');

const outCsv = htmlPath.replace(/\.html$/i, '.csv');
fs.writeFileSync(outCsv, csvContent, 'utf8');
console.log(`✅ CSV written to ${outCsv}`);
