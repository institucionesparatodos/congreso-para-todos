// Avisa a n8n de que las infografías ya están publicadas en GitHub Pages.
// Llama a la "resume URL" del nodo Wait de n8n que viene en cada lote.
import fs from 'node:fs';

const ARCHIVO = 'resultado-lotes.json';
if (!fs.existsSync(ARCHIVO)) {
  console.log('No hay resultados que avisar.');
  process.exit(0);
}

const lotes = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));

for (const lote of lotes) {
  if (!lote.resume_url) continue;
  try {
    const respuesta = await fetch(lote.resume_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lote_id: lote.lote_id, votaciones: lote.votaciones }),
    });
    console.log(`Aviso a n8n (${lote.lote_id}): ${respuesta.status}`);
  } catch (error) {
    console.log(`No se pudo avisar a n8n (${lote.lote_id}): ${error.message}`);
  }
}
