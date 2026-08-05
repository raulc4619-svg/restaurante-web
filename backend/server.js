require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://raulc4619-svg.github.io',
    'http://localhost',
    'http://127.0.0.1',
    /^http:\/\/localhost:\d+$/,
    /^file:\/\//
  ]
}));
app.use(express.json());

// ── HELPERS ───────────────────────────────────────────────────────────────────
const r2 = n => Math.round(n * 100) / 100;

function calcularImpuestos(items, preciosConIva) {
  return items.map(item => {
    const totalLinea = r2(item.price * item.qty);
    let baseImponible, iva;

    if (preciosConIva) {
      // El precio ya incluye IVA 15% → base = total / 1.15
      baseImponible = r2(totalLinea / 1.15);
      iva           = r2(totalLinea - baseImponible);
    } else {
      // El precio es sin IVA → IVA = base * 15%
      baseImponible = totalLinea;
      iva           = r2(totalLinea * 0.15);
    }

    return {
      cantidad: item.qty,
      nombre:   item.name,
      precio_unitario: item.price,
      descuento: 0,
      precio_total_sin_impuestos: baseImponible,
      impuestos: [{
        base_imponible:   baseImponible,
        codigo:            '2',
        codigo_porcentaje: '2',
        tarifa:            15,
        valor:             iva
      }]
    };
  });
}

// ── ENDPOINT: emitir factura ──────────────────────────────────────────────────
app.post('/factura', async (req, res) => {
  const {
    cliente_nombre,
    cliente_identificacion,
    cliente_tipo_id,  // '04'=RUC, '05'=Cédula, '07'=Consumidor Final, '08'=Pasaporte
    cliente_email,
    items,            // [{ name, price, qty }]
    total,
    metodo_pago,      // 'efectivo' | 'tarjeta_debito' | 'tarjeta_credito' | 'transferencia'
    secuencial        // número correlativo de factura
  } = req.body;

  // Validaciones básicas
  if (!cliente_nombre || !cliente_identificacion || !items || !items.length) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: cliente_nombre, cliente_identificacion, items' });
  }

  const preciosConIva = process.env.PRECIOS_CON_IVA === 'true';
  const itemsCalc     = calcularImpuestos(items, preciosConIva);

  const subtotalBase  = r2(itemsCalc.reduce((a, i) => a + i.precio_total_sin_impuestos, 0));
  const totalIva      = r2(itemsCalc.reduce((a, i) => a + i.impuestos[0].valor, 0));
  const totalFinal    = r2(subtotalBase + totalIva);

  // Fecha Ecuador (UTC-5)
  const ahora = new Date();
  const fechaEc = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  const fechaEmision = fechaEc.toISOString().replace('Z', '-05:00');

  const payload = {
    ambiente:     parseInt(process.env.DATIL_AMBIENTE) || 1,
    tipo_emision: 1,
    secuencial:   secuencial || 1,
    fecha_emision: fechaEmision,
    emisor: {
      ruc:               process.env.EMISOR_RUC,
      razon_social:      process.env.EMISOR_RAZON_SOCIAL,
      nombre_comercial:  process.env.EMISOR_NOMBRE_COMERCIAL,
      direccion:         process.env.EMISOR_DIRECCION,
      obligado_contabilidad: process.env.EMISOR_OBLIGADO === 'true',
      establecimiento: {
        punto_emision: process.env.EMISOR_PUNTO_EMISION || '001',
        codigo:        process.env.EMISOR_ESTABLECIMIENTO || '001',
        direccion:     process.env.EMISOR_DIRECCION
      }
    },
    moneda: 'USD',
    comprador: {
      razon_social:       cliente_nombre,
      identificacion:     cliente_identificacion,
      tipo_identificacion: cliente_tipo_id || '07',
      email:   cliente_email || '',
      direccion: 'Ecuador'
    },
    items: itemsCalc,
    subtotal_sin_impuestos: subtotalBase,
    impuestos: [{
      codigo:            '2',
      codigo_porcentaje: '2',
      base_imponible:    subtotalBase,
      valor:             totalIva
    }],
    total: totalFinal,
    pagos: [{
      medio: metodo_pago || 'efectivo',
      total: totalFinal
    }]
  };

  try {
    const resp = await fetch('https://link.datil.co/invoices/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Key':      process.env.DATIL_API_KEY,
        'X-Password': process.env.DATIL_CERT_PASSWORD
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[Datil] Error:', JSON.stringify(data));
      return res.status(resp.status).json({ ok: false, error: data });
    }

    console.log('[Datil] Factura emitida:', data.id || data.clave_acceso || '—');
    res.json({
      ok:           true,
      id:           data.id,
      clave_acceso: data.clave_acceso,
      estado:       data.estado,
      ride_url:     data.ride || null,
      pdf_url:      data.pdf  || null
    });

  } catch (err) {
    console.error('[Fetch] Error:', err.message);
    res.status(500).json({ ok: false, error: 'Error de conexión con Datil: ' + err.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ambiente: process.env.DATIL_AMBIENTE === '2' ? 'PRODUCCIÓN' : 'PRUEBAS',
    emisor:   process.env.EMISOR_NOMBRE_COMERCIAL || '—'
  });
});

// ── INICIO ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🍽  Backend Restaurante corriendo en puerto ${PORT}`);
  console.log(`   Ambiente Datil: ${process.env.DATIL_AMBIENTE === '2' ? '🔴 PRODUCCIÓN' : '🟡 PRUEBAS'}`);
  console.log(`   Emisor: ${process.env.EMISOR_NOMBRE_COMERCIAL || 'No configurado'}\n`);
});
