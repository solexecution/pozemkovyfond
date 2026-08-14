// fetch_bo_pdf.js
// Node script to download the BO PDF for a given prfNumber & cadastralUnitCode
// Usage: node fetch_bo_pdf.js <prfNumber> <cadastralUnitCode>
// Example: node fetch_bo_pdf.js 1208 859559

const https = require('https');
const fs = require('fs');

const [,, prfNumber, cadastralUnitCode] = process.argv;
if (!prfNumber || !cadastralUnitCode) {
  console.error('Usage: node fetch_bo_pdf.js <prfNumber> <cadastralUnitCode>');
  process.exit(1);
}

const url = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${prfNumber}&cadastralUnitCode=${cadastralUnitCode}&outputType=pdf`;
const outFile = `bo_${prfNumber}_${cadastralUnitCode}.pdf`;

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error('Failed to download PDF, status:', res.statusCode);
    res.resume();
    return;
  }
  const file = fs.createWriteStream(outFile);
  res.pipe(file);
  file.on('finish', () => {
    file.close(() => console.log(`✅ PDF saved to ${outFile}`));
  });
}).on('error', (e) => {
  console.error('Request error:', e.message);
});
