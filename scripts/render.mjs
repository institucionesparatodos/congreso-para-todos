// Genera las infografías de las votaciones a partir de los JSON de la carpeta "datos".
// Cada JSON es un lote (las votaciones de un día + la dirección para avisar a n8n).
// Solo procesa las votaciones que todavía no tienen imágenes en "docs/v/<id>/".
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RAIZ = process.cwd();
const DATOS = path.join(RAIZ, 'datos');
const SALIDA = path.join(RAIZ, 'docs', 'v');
const PLANTILLA = pathToFileURL(path.join(RAIZ, 'plantilla', 'votacion.html')).href;
const PLANO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'hemiciclo.json'), 'utf8'));
const RESULTADO = path.join(RAIZ, 'resultado-lotes.json'); // lo lee avisar.mjs (no se guarda en el repositorio)

const yaGenerado = (id) => fs.existsSync(path.join(SALIDA, id, 'listo.json'));

const lotes = fs
  .readdirSync(DATOS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8')))
  .filter((lote) => Array.isArray(lote.votaciones) && lote.votaciones.some((v) => !yaGenerado(v.id)));

if (lotes.length === 0) {
  console.log('No hay votaciones pendientes.');
  fs.writeFileSync(RESULTADO, '[]');
  process.exit(0);
}

const navegador = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const pagina = await navegador.newPage({ viewport: { width: 2160, height: 1350 }, deviceScaleFactor: 1 });
await pagina.goto(PLANTILLA, { waitUntil: 'networkidle' });
await pagina.evaluate(() => document.fonts.ready);

// Instagram solo acepta JPEG en la publicación por API
const foto = (destino, opciones) => pagina.screenshot({ path: destino, type: 'jpeg', quality: 92, ...opciones });

async function generar(v, carpeta) {
  const imagenes = [];
  if (v.plantilla === 'nominal') {
    // 1) Votos por grupo
    await pagina.evaluate((d) => window.pintar(d, 'grupos'), v.datos);
    await pagina.evaluate(() => document.fonts.ready);
    await pagina.locator('#lienzo').screenshot({ path: path.join(carpeta, '01-grupos.jpg'), type: 'jpeg', quality: 92 });
    imagenes.push('01-grupos.jpg');
    // 2) Hemiciclo: un lienzo de 2160 px cortado en dos imágenes que empalman
    await pagina.evaluate(([d, p]) => window.pintar(d, 'hemiciclo', p), [v.datos, PLANO]);
    await pagina.evaluate(() => document.fonts.ready);
    await foto(path.join(carpeta, '02-hemiciclo-a.jpg'), { clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    await foto(path.join(carpeta, '03-hemiciclo-b.jpg'), { clip: { x: 1080, y: 0, width: 1080, height: 1350 } });
    await foto(path.join(carpeta, 'hemiciclo-completo.jpg'), { clip: { x: 0, y: 0, width: 2160, height: 1350 } });
    imagenes.push('02-hemiciclo-a.jpg', '03-hemiciclo-b.jpg');
  } else {
    // Votación secreta o por asentimiento: una sola imagen con el resultado total
    await pagina.evaluate((d) => window.pintar(d, 'resultado'), v.datos);
    await pagina.evaluate(() => document.fonts.ready);
    await pagina.locator('#lienzo').screenshot({ path: path.join(carpeta, '01-resultado.jpg'), type: 'jpeg', quality: 92 });
    imagenes.push('01-resultado.jpg');
  }

  // Hoja de vista previa para Telegram: la primera infografía + el hemiciclo completo
  const b64 = (n) => `data:image/jpeg;base64,${fs.readFileSync(path.join(carpeta, n)).toString('base64')}`;
  const partes = v.plantilla === 'nominal'
    ? `<img src="${b64('01-grupos.jpg')}" style="width:540px;height:675px"><img src="${b64('hemiciclo-completo.jpg')}" style="width:1080px;height:675px">`
    : `<img src="${b64('01-resultado.jpg')}" style="width:540px;height:675px">`;
  const hoja = await navegador.newPage({ viewport: { width: 1700, height: 720 }, deviceScaleFactor: 1 });
  await hoja.setContent(
    `<html><body style="margin:0;background:#DDE3E6"><div id="hoja" style="display:flex;gap:20px;padding:20px;width:max-content">${partes}</div>
     <style>img{display:block;border-radius:12px}</style></body></html>`,
    { waitUntil: 'load' }
  );
  await hoja.locator('#hoja').screenshot({ path: path.join(carpeta, 'hoja.jpg'), type: 'jpeg', quality: 85 });
  await hoja.close();
  return imagenes;
}

const resultados = [];
for (const lote of lotes) {
  const resumen = { lote_id: lote.lote_id, resume_url: lote.resume_url || null, votaciones: [] };
  for (const v of lote.votaciones) {
    const carpeta = path.join(SALIDA, v.id);
    if (yaGenerado(v.id)) {
      resumen.votaciones.push(JSON.parse(fs.readFileSync(path.join(carpeta, 'listo.json'), 'utf8')));
      continue;
    }
    fs.mkdirSync(carpeta, { recursive: true });
    let listo;
    try {
      const imagenes = await generar(v, carpeta);
      listo = { id: v.id, plantilla: v.plantilla, imagenes, hoja: 'hoja.jpg', avisos: [], generado: new Date().toISOString() };
      fs.writeFileSync(path.join(carpeta, 'listo.json'), JSON.stringify(listo, null, 2));
      console.log(`${v.id}: ${imagenes.length} imágenes`);
    } catch (error) {
      // No se guarda listo.json: se volverá a intentar en la próxima ejecución
      listo = { id: v.id, plantilla: v.plantilla, imagenes: [], hoja: null, avisos: [`Error al generar: ${error.message}`] };
      console.log(`${v.id}: ERROR ${error.message}`);
    }
    resumen.votaciones.push(listo);
  }
  resultados.push(resumen);
}

await navegador.close();
fs.writeFileSync(RESULTADO, JSON.stringify(resultados, null, 2));
