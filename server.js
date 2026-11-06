const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- Estado en memoria ----------
let pedidos = [];
let contador = 104;
let inventario = {
  'Yogurt griego': 20,
  'Yogurt de fresa': 20,
  'Yogurt bajo en azúcar': 20,
  'Fresa': 30,
  'Banano': 30,
  'Arándanos': 30,
  'Granola': 30,
  'Almendras': 30,
  'Avena': 30,
};

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function servirArchivo(res, ruta) {
  fs.readFile(ruta, (err, contenido) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(ruta).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(contenido);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ruta = url.pathname;

  try {
    // ---------- API ----------
    if (ruta === '/api/info' && req.method === 'GET') {
      // En internet (Render) usa la URL pública; en local usa la IP del WiFi
      const publica = process.env.RENDER_EXTERNAL_URL ||
        `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      if (publica && !publica.includes('localhost') && !/^https?:\/\/192\.168\./.test(publica)) {
        return json(res, 200, { url: publica });
      }
      const interfaces = os.networkInterfaces();
      let ip = 'localhost';
      for (const nombre of Object.keys(interfaces)) {
        for (const iface of interfaces[nombre] || []) {
          if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
        }
      }
      return json(res, 200, { ip, port: PORT, url: `http://${ip}:${PORT}` });
    }

    if (ruta === '/api/pedidos' && req.method === 'GET') {
      const ids = url.searchParams.get('ids');
      if (ids) {
        const lista = ids.split(',').map((s) => s.trim()).filter(Boolean);
        return json(res, 200, { pedidos: pedidos.filter((p) => lista.includes(p.id)) });
      }
      return json(res, 200, { pedidos });
    }

    if (ruta === '/api/pedidos' && req.method === 'POST') {
      const body = await leerBody(req);
      if (!body.tipo || !body.base || !body.total) {
        return json(res, 400, { error: 'Faltan datos del pedido' });
      }
      // El cliente propone su id: si ya existe, devolvemos el pedido (reintento sin duplicar)
      let id;
      if (typeof body.id === 'string' && /^YOG-[A-Za-z0-9-]{2,20}$/.test(body.id)) {
        const existente = pedidos.find((p) => p.id === body.id);
        if (existente) return json(res, 200, { pedido: existente, yaExiste: true });
        id = body.id;
        const num = parseInt(id.replace('YOG-', ''), 10);
        if (!isNaN(num) && num >= contador) contador = num + 1;
      } else {
        id = 'YOG-' + contador++;
      }
      const pedido = {
        id,
        tipo: body.tipo,
        base: body.base,
        frutas: body.frutas || [],
        cereales: body.cereales || [],
        horaRetiro: body.horaRetiro || '',
        pago: body.pago || '',
        total: body.total,
        estado: 'En preparación',
        creado: Date.now(),
      };
      // Plan semanal: lista de los 3 cupos elegidos
      if (Array.isArray(body.detallePlan) && body.detallePlan.length) {
        pedido.detallePlan = body.detallePlan.slice(0, 3).map((c) => ({
          dia: String(c.dia || '').slice(0, 20),
          tipo: String(c.tipo || '').slice(0, 30),
          fruta: String(c.fruta || '').slice(0, 30),
        }));
      }
      pedidos.unshift(pedido);

      // Descontar inventario
      if (pedido.detallePlan) {
        pedido.detallePlan.forEach((c) => {
          if (inventario[pedido.base] !== undefined) inventario[pedido.base]--;
          if (inventario[c.fruta] !== undefined) inventario[c.fruta]--;
        });
      } else {
        if (inventario[pedido.base] !== undefined) inventario[pedido.base]--;
        pedido.frutas.forEach((f) => { if (inventario[f] !== undefined) inventario[f]--; });
        pedido.cereales.forEach((c) => { if (inventario[c] !== undefined) inventario[c]--; });
      }

      return json(res, 201, { pedido });
    }

    // Escaneo del QR del ticket: marca entregado
    const matchEntregar = ruta.match(/^\/api\/pedidos\/([^/]+)\/entregar$/);
    if (matchEntregar && req.method === 'POST') {
      const id = decodeURIComponent(matchEntregar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (pedido.estado === 'Cancelado') return json(res, 400, { error: 'El pedido está cancelado', cancelado: true });
      if (pedido.estado === 'Entregado') return json(res, 200, { pedido, yaEntregado: true });
      pedido.estado = 'Entregado';
      pedido.entregado = Date.now();
      return json(res, 200, { pedido });
    }

    // Cancelación del cliente: solo mientras está en preparación
    const matchCancelar = ruta.match(/^\/api\/pedidos\/([^/]+)\/cancelar$/);
    if (matchCancelar && req.method === 'POST') {
      const id = decodeURIComponent(matchCancelar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (pedido.estado === 'Cancelado') return json(res, 200, { pedido, yaCancelado: true });
      if (pedido.estado === 'Entregado') return json(res, 400, { error: 'El pedido ya fue entregado y no se puede cancelar' });
      const body = await leerBody(req);
      pedido.estado = 'Cancelado';
      pedido.cancelado = Date.now();
      pedido.motivo = String(body.motivo || 'Sin motivo').slice(0, 80);
      return json(res, 200, { pedido });
    }

    // Calificación del cliente (solo pedidos entregados)
    const matchCalificar = ruta.match(/^\/api\/pedidos\/([^/]+)\/calificar$/);
    if (matchCalificar && req.method === 'POST') {
      const id = decodeURIComponent(matchCalificar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (pedido.estado !== 'Entregado') return json(res, 400, { error: 'El pedido aún no ha sido entregado' });
      const body = await leerBody(req);
      const estrellas = Math.min(5, Math.max(1, parseInt(body.estrellas, 10) || 0));
      if (!estrellas) return json(res, 400, { error: 'Número de estrellas inválido' });
      const comentarios = (Array.isArray(body.comentarios) ? body.comentarios : [])
        .map((c) => String(c).slice(0, 40))
        .filter(Boolean)
        .slice(0, 6);
      pedido.calificacion = {
        estrellas,
        comentarios,
        fecha: Date.now(),
      };
      return json(res, 200, { pedido });
    }

    if (ruta === '/api/inventario' && req.method === 'GET') {
      return json(res, 200, { inventario });
    }

    // ---------- Archivos estáticos ----------
    if (ruta === '/' || ruta === '/index.html') return servirArchivo(res, path.join(PUBLIC_DIR, 'index.html'));
    if (ruta === '/admin' || ruta === '/admin.html') return servirArchivo(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (ruta === '/entrega') {
      // Página de confirmación al escanear el QR del ticket
      return servirArchivo(res, path.join(PUBLIC_DIR, 'entrega.html'));
    }

    const archivo = path.normalize(path.join(PUBLIC_DIR, ruta));
    if (!archivo.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end();
    }
    return servirArchivo(res, archivo);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`YogApp lista en http://localhost:${PORT}`);
  console.log(`Panel admin: http://localhost:${PORT}/admin`);
});
