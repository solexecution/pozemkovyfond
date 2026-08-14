// fetch_bo_html.cjs
// Node script (CommonJS) to download the BO HTML for a given prfNumber & cadastralUnitCode
// Usage: node fetch_bo_html.cjs <prfNumber> <cadastralUnitCode>
// Example: node fetch_bo_html.cjs 1208 859559

const https = require('https');
const fs = require('fs');

const [,, prfNumber, cadastralUnitCode] = process.argv;
if (!prfNumber || !cadastralUnitCode) {
  console.error('Usage: node fetch_bo_html.cjs <prfNumber> <cadastralUnitCode>');
  process.exit(1);
}

const url = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${prfNumber}&cadastralUnitCode=${cadastralUnitCode}&outputType=html`;
const outFile = `bo_${prfNumber}_${cadastralUnitCode}.html`;

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error('Failed to download HTML, status:', res.statusCode);
    res.resume();
    return;
  }
  const file = fs.createWriteStream(outFile);
  res.pipe(file);
  file.on('finish', () => {
    file.close(() => console.log(`✅ HTML saved to ${outFile}`));
  });
}).on('error', (e) => {
  console.error('Request error:', e.message);
});
