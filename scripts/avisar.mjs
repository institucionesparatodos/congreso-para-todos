// Avisa a n8n de que las imágenes ya están en el repositorio.
// Llama a la "resume URL" del nodo Wait de n8n que viene en cada lote o publicación.
import fs from 'node:fs';

const ARCHIVO = 'resultado-lotes.json';
if (!fs.existsSync(ARCHIVO)) {
  console.log('No hay resultados que avisar.');
  process.exit(0);
}

const resultados = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));

for (const r of resultados) {
  if (!r.resume_url) continue;
  const { resume_url, ...cuerpo } = r;
  try {
    const respuesta = await fetch(resume_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20000),
    });
    console.log(`Aviso a n8n (${r.lote_id}): ${respuesta.status}`);
  } catch (error) {
    console.log(`No se pudo avisar a n8n (${r.lote_id}): ${error.message}`);
  }
}
