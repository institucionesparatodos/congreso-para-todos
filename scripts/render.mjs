// Genera las imágenes a partir de los JSON de la carpeta "datos". Hay dos tipos de JSON:
//  - Lote (las votaciones de un día): infografías en "docs/v/<id>/".
//  - Publicación (tipo "publicacion"): diapositivas de texto del carrusel en "docs/p/<pub_id>/".
// Cada JSON se procesa una sola vez (marca en "docs/l/<lote_id o pub_id>.json") y se avisa a n8n.
// Las votaciones que ya tienen imágenes en "docs/v/<id>/" no se vuelven a generar.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RAIZ = process.cwd();
const DATOS = path.join(RAIZ, 'datos');
const SALIDA = path.join(RAIZ, 'docs', 'v');
const HECHOS = path.join(RAIZ, 'docs', 'l');
const PLANTILLA = pathToFileURL(path.join(RAIZ, 'plantilla', 'votacion.html')).href;
const PLANTILLA_TEXTOS = pathToFileURL(path.join(RAIZ, 'plantilla', 'textos.html')).href;
const SALIDA_PUB = path.join(RAIZ, 'docs', 'p');
const PLANO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'hemiciclo.json'), 'utf8'));
const RESULTADO = path.join(RAIZ, 'resultado-lotes.json'); // lo lee avisar.mjs (no se guarda en el repositorio)

const yaGenerado = (id) => fs.existsSync(path.join(SALIDA, id, 'listo.json'));
const loteHecho = (id) => fs.existsSync(path.join(HECHOS, `${id}.json`));

const pendientes = fs
  .readdirSync(DATOS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8')));
const lotes = pendientes.filter((l) => Array.isArray(l.votaciones) && l.lote_id && !loteHecho(l.lote_id));
const publicaciones = pendientes.filter((p) => p.tipo === 'publicacion' && p.pub_id && Array.isArray(p.paginas) && !loteHecho(p.pub_id));

if (lotes.length === 0 && publicaciones.length === 0) {
  console.log('No hay nada pendiente.');
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
  // Marca el lote como hecho (sin la dirección de aviso, que no hace falta guardar)
  fs.mkdirSync(HECHOS, { recursive: true });
  fs.writeFileSync(path.join(HECHOS, `${lote.lote_id}.json`), JSON.stringify({ lote_id: lote.lote_id, votaciones: resumen.votaciones }, null, 2));
}

// ---------- Diapositivas de texto de las publicaciones ----------
if (publicaciones.length) {
  const textos = await navegador.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  await textos.goto(PLANTILLA_TEXTOS, { waitUntil: 'networkidle' });
  await textos.evaluate(() => document.fonts.ready);
  for (const pub of publicaciones) {
    const carpeta = path.join(SALIDA_PUB, pub.pub_id);
    fs.mkdirSync(carpeta, { recursive: true });
    const resumen = { lote_id: pub.pub_id, pub_id: pub.pub_id, id: pub.id, resume_url: pub.resume_url || null, imagenes: [], avisos: [] };
    try {
      let n = 0;
      for (const pagina of pub.paginas) {
        n++;
        const nombre = `${String(n).padStart(2, '0')}-${pagina.pagina}.jpg`;
        await textos.evaluate((d) => window.pintar(d), { ...pub.comun, ...pagina });
        await textos.evaluate(() => document.fonts.ready);
        await textos.locator('#lienzo').screenshot({ path: path.join(carpeta, nombre), type: 'jpeg', quality: 92 });
        resumen.imagenes.push({ pagina: pagina.pagina, clave: pagina.clave || pagina.pagina, archivo: nombre });
      }
      console.log(`${pub.pub_id}: ${n} diapositivas`);
    } catch (error) {
      resumen.avisos.push(`Error al generar: ${error.message}`);
      console.log(`${pub.pub_id}: ERROR ${error.message}`);
    }
    resultados.push(resumen);
    fs.mkdirSync(HECHOS, { recursive: true });
    fs.writeFileSync(path.join(HECHOS, `${pub.pub_id}.json`), JSON.stringify({ ...resumen, resume_url: undefined }, null, 2));
  }
  await textos.close();
}

await navegador.close();
fs.writeFileSync(RESULTADO, JSON.stringify(resultados, null, 2));
