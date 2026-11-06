const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// Topping adicional en Estandar y Especial: $500
const TOPPING_EXTRA = 500;
const INCLUIDOS = {
  'Vaso Estandar': { frutas: 1, cereales: 1 },
  'Vaso Especial': { frutas: 2, cereales: 2 },
  'Vaso Personalizado': { frutas: 0, cereales: 0 },
};
const PLANES = {
  clasico: { nombre: 'Plan Clásico', precio: 11000, tipo: 'Vaso Estandar' },
  premium: { nombre: 'Plan Premium', precio: 17000, tipo: 'Vaso Especial' },
};
const DIAS_PLAN = ['Lunes', 'Miércoles', 'Viernes'];

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

function lista(valor, max = 3) {
  return (Array.isArray(valor) ? valor : [])
    .map((s) => String(s).slice(0, 30))
    .filter(Boolean)
    .slice(0, max);
}

function extrasDeCupo(cupo) {
  const inc = INCLUIDOS[cupo.tipo] || INCLUIDOS['Vaso Estandar'];
  return Math.max(0, cupo.frutas.length - inc.frutas) +
    Math.max(0, cupo.cereales.length - inc.cereales);
}

function recalcularTotalPlan(pedido) {
  const extras = pedido.detallePlan.reduce((s, c) => s + extrasDeCupo(c), 0);
  pedido.total = pedido.totalBase + extras * TOPPING_EXTRA;
}

function descontarInventario(item) {
  if (inventario[item] !== undefined) inventario[item] = Math.max(0, inventario[item] - 1);
}

function entregarSiguienteCupo(pedido) {
  const indice = pedido.detallePlan.findIndex((c) => !c.entregado);
  if (indice < 0) return null;
  const cupo = pedido.detallePlan[indice];
  cupo.entregado = true;
  cupo.entregadoEn = Date.now();
  const planCompleto = pedido.detallePlan.every((c) => c.entregado);
  if (planCompleto) {
    pedido.estado = 'Entregado';
    pedido.entregado = Date.now();
  }
  return { cupo, indice, planCompleto };
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
        const listaIds = ids.split(',').map((s) => s.trim()).filter(Boolean);
        return json(res, 200, { pedidos: pedidos.filter((p) => listaIds.includes(p.id)) });
      }
      return json(res, 200, { pedidos });
    }

    if (ruta === '/api/pedidos' && req.method === 'POST') {
      const body = await leerBody(req);
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

      const plan = PLANES[body.planClave];
      if (plan) {
        const cupos = (Array.isArray(body.detallePlan) ? body.detallePlan : []).slice(0, 3).map((c, i) => ({
          dia: DIAS_PLAN[i],
          tipo: plan.tipo,
          frutas: lista(c.frutas),
          cereales: lista(c.cereales),
          entregado: false,
        }));
        if (cupos.length !== 3) return json(res, 400, { error: 'El plan necesita los 3 vasos' });
        const pedido = {
          id,
          tipo: plan.nombre,
          planClave: body.planClave,
          base: 'Yogurt griego',
          frutas: [],
          cereales: [],
          pago: String(body.pago || '').slice(0, 30),
          totalBase: plan.precio,
          total: 0,
          estado: 'En preparación',
          creado: Date.now(),
          detallePlan: cupos,
        };
        recalcularTotalPlan(pedido);
        pedidos.unshift(pedido);

        cupos.forEach((c) => {
          descontarInventario('Yogurt griego');
          c.frutas.forEach(descontarInventario);
          c.cereales.forEach(descontarInventario);
        });

        return json(res, 201, { pedido });
      }

      if (!body.tipo || !body.base || !body.total) {
        return json(res, 400, { error: 'Faltan datos del pedido' });
      }
      const pedido = {
        id,
        tipo: String(body.tipo).slice(0, 40),
        base: String(body.base).slice(0, 40),
        frutas: lista(body.frutas),
        cereales: lista(body.cereales),
        pago: String(body.pago || '').slice(0, 30),
        total: body.total,
        estado: 'En preparación',
        creado: Date.now(),
      };
      pedidos.unshift(pedido);

      descontarInventario(pedido.base);
      pedido.frutas.forEach(descontarInventario);
      pedido.cereales.forEach(descontarInventario);

      return json(res, 201, { pedido });
    }

    // Escaneo del QR del ticket: marca entregado (en planes, reclama el próximo vaso)
    const matchEntregar = ruta.match(/^\/api\/pedidos\/([^/]+)\/entregar$/);
    if (matchEntregar && req.method === 'POST') {
      const id = decodeURIComponent(matchEntregar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (pedido.estado === 'Cancelado') return json(res, 400, { error: 'El pedido está cancelado', cancelado: true });
      if (!pedido.detallePlan) {
        if (pedido.estado === 'Entregado') return json(res, 200, { pedido, yaEntregado: true });
        pedido.estado = 'Entregado';
        pedido.entregado = Date.now();
        return json(res, 200, { pedido });
      }
      const cupo = entregarSiguienteCupo(pedido);
      if (!cupo) return json(res, 200, { pedido, yaEntregado: true, planCompleto: true });
      return json(res, 200, { pedido, cupo: cupo.cupo, indice: cupo.indice, planCompleto: cupo.planCompleto });
    }

    // Entrega de un vaso concreto del plan (panel del stand)
    const matchCupoEntregar = ruta.match(/^\/api\/pedidos\/([^/]+)\/plan\/(\d+)\/entregar$/);
    if (matchCupoEntregar && req.method === 'POST') {
      const id = decodeURIComponent(matchCupoEntregar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (!pedido.detallePlan) return json(res, 400, { error: 'Este pedido no es un plan' });
      if (pedido.estado === 'Cancelado') return json(res, 400, { error: 'El plan está cancelado', cancelado: true });
      const indice = Number(matchCupoEntregar[2]);
      const cupo = pedido.detallePlan[indice];
      if (!cupo) return json(res, 404, { error: 'Vaso no encontrado' });
      if (cupo.entregado) return json(res, 200, { pedido, cupo, indice, yaEntregado: true, planCompleto: pedido.estado === 'Entregado' });
      cupo.entregado = true;
      cupo.entregadoEn = Date.now();
      const planCompleto = pedido.detallePlan.every((c) => c.entregado);
      if (planCompleto) {
        pedido.estado = 'Entregado';
        pedido.entregado = Date.now();
      }
      return json(res, 200, { pedido, cupo, indice, planCompleto });
    }

    // Edición de un vaso del plan que todavía no se ha reclamado
    const matchCupoEditar = ruta.match(/^\/api\/pedidos\/([^/]+)\/plan\/(\d+)\/editar$/);
    if (matchCupoEditar && req.method === 'POST') {
      const id = decodeURIComponent(matchCupoEditar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (!pedido.detallePlan) return json(res, 400, { error: 'Este pedido no es un plan' });
      if (pedido.estado === 'Cancelado') return json(res, 400, { error: 'El plan está cancelado' });
      const indice = Number(matchCupoEditar[2]);
      const cupo = pedido.detallePlan[indice];
      if (!cupo) return json(res, 404, { error: 'Vaso no encontrado' });
      if (cupo.entregado) return json(res, 400, { error: 'Ese vaso ya fue reclamado en el stand' });

      const body = await leerBody(req);
      const frutas = lista(body.frutas);
      const cereales = lista(body.cereales);
      if (!frutas.length) return json(res, 400, { error: 'Elige al menos una fruta' });

      const contar = (arr) => arr.reduce((m, x) => {
        m[x] = (m[x] || 0) + 1;
        return m;
      }, {});
      const antes = contar([...cupo.frutas, ...cupo.cereales]);
      const despues = contar([...frutas, ...cereales]);
      new Set([...Object.keys(antes), ...Object.keys(despues)]).forEach((item) => {
        const diff = (despues[item] || 0) - (antes[item] || 0);
        if (inventario[item] !== undefined) inventario[item] = Math.max(0, inventario[item] - diff);
      });

      cupo.frutas = frutas;
      cupo.cereales = cereales;
      recalcularTotalPlan(pedido);
      return json(res, 200, { pedido, cupo, indice, total: pedido.total });
    }

    // Cancelación del cliente: pedidos normales en preparación, planes sin vasos reclamados
    const matchCancelar = ruta.match(/^\/api\/pedidos\/([^/]+)\/cancelar$/);
    if (matchCancelar && req.method === 'POST') {
      const id = decodeURIComponent(matchCancelar[1]);
      const pedido = pedidos.find((p) => p.id === id);
      if (!pedido) return json(res, 404, { error: 'Pedido no encontrado' });
      if (pedido.estado === 'Cancelado') return json(res, 200, { pedido, yaCancelado: true });
      if (pedido.estado === 'Entregado') return json(res, 400, { error: 'El pedido ya fue entregado y no se puede cancelar' });
      if (pedido.detallePlan && pedido.detallePlan.some((c) => c.entregado)) {
        return json(res, 400, { error: 'Ya reclamaste un vaso del plan, no se puede cancelar' });
      }
      const body = await leerBody(req);
      pedido.estado = 'Cancelado';
      pedido.cancelado = Date.now();
      pedido.motivo = String(body.motivo || 'Sin motivo').slice(0, 80);
      return json(res, 200, { pedido });
    }

    // Calificación del cliente (solo pedidos entregados; los planes al completar los 3 vasos)
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
