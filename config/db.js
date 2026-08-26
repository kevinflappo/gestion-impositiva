const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Si corre dentro de Electron, main.js ya seteó DB_PATH apuntando a la carpeta
// de datos de usuario (AppData) antes de requerir server.js. Si corrés
// `node server.js` a mano (fuera de Electron), no existe esa variable y usa
// la ruta relativa de siempre — mismo comportamiento que tenías.
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../vencimientos.db');
console.log(`📁 Base de datos: ${dbPath}`);

// sqlite3 NO crea la carpeta contenedora sola — si no existe, la conexión
// falla en silencio. La primera vez que corre en una PC nueva (o la primera
// vez que Electron usa una carpeta de AppData fresca), esa carpeta todavía
// no existe, así que la creamos nosotros antes de conectar.
const carpetaDb = path.dirname(dbPath);
if (!fs.existsSync(carpetaDb)) {
    fs.mkdirSync(carpetaDb, { recursive: true });
    console.log(`📁 Carpeta creada: ${carpetaDb}`);
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error conectando a SQLite:', err.message);
    } else {
        console.log('✅ Conectado a la base de datos SQLite.');
        inicializarEstructura();
    }
});

function inicializarEstructura() {
    db.serialize(() => {
        // 1. Clientes
        db.run(`
            CREATE TABLE IF NOT EXISTS clientes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                razon_social TEXT NOT NULL,
                cuit TEXT NOT NULL UNIQUE,
                clave_fiscal TEXT,
                telefono TEXT,
                email_notificacion TEXT
            )
        `);

        // 2. Impuestos
        db.run(`
            CREATE TABLE IF NOT EXISTS impuestos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre TEXT NOT NULL UNIQUE
            )
        `);

        // 🧹 MIGRACIÓN: agrega tipo_agenda si la tabla ya existía de antes (SQLite no
        // tiene "ADD COLUMN IF NOT EXISTS", así que lo intentamos directo y si la
        // columna ya existe, ignoramos el error "duplicate column" a propósito.
        // 'automatica' = el scraper calcula la fecha (Monotributo, IVA, etc).
        // 'manual'     = el contador carga fecha y monto a mano cada vez (Honorarios, etc).
        db.run(`ALTER TABLE impuestos ADD COLUMN tipo_agenda TEXT NOT NULL DEFAULT 'automatica'`, (err) => {
            if (err && !/duplicate column/i.test(err.message)) {
                console.error('❌ Error agregando tipo_agenda:', err.message);
            }
        });

        // 3. Cliente - Impuestos (con categoría)
        db.run(`
            CREATE TABLE IF NOT EXISTS cliente_impuestos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cliente_id INTEGER NOT NULL,
                impuesto_id INTEGER NOT NULL,
                categoria TEXT,
                FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
                FOREIGN KEY (impuesto_id) REFERENCES impuestos(id) ON DELETE CASCADE,
                UNIQUE(cliente_id, impuesto_id)
            )
        `);

        // 4. Vencimientos (AHORA: siempre una instancia real por cliente, nunca "molde")
        db.run(`
            CREATE TABLE IF NOT EXISTS vencimientos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cliente_id INTEGER,
                impuesto_id INTEGER NOT NULL,
                terminacion_cuit INTEGER,
                periodo TEXT,
                fecha_vencimiento TEXT NOT NULL,
                monto REAL DEFAULT 0,
                estado TEXT DEFAULT 'PENDIENTE',
                FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
                FOREIGN KEY (impuesto_id) REFERENCES impuestos(id) ON DELETE CASCADE
            )
        `);

        // 4b. Agenda Impositiva: el "molde" de fechas oficiales por terminación de CUIT.
        // Acá escribe scraper.py. vencimientos ya NO se llena con filas moldes.
        db.run(`
            CREATE TABLE IF NOT EXISTS agenda_impositiva (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                impuesto_id INTEGER NOT NULL,
                terminacion_cuit INTEGER NOT NULL,
                periodo TEXT NOT NULL,
                fecha_vencimiento TEXT NOT NULL,
                FOREIGN KEY (impuesto_id) REFERENCES impuestos(id) ON DELETE CASCADE,
                UNIQUE(impuesto_id, terminacion_cuit, periodo)
            )
        `);

        // 🧹 MIGRACIÓN: las filas viejas de vencimientos con cliente_id NULL eran "moldes"
        // del scraper. Ese rol ahora lo cumple agenda_impositiva, así que se purgan.
        // También limpiamos filas reales viejas sin período (formato previo a este cambio),
        // ya que se van a regenerar automáticamente vía sincronizarVencimientosCliente().
        db.run(`DELETE FROM vencimientos WHERE cliente_id IS NULL OR periodo IS NULL`);

        // Evita filas duplicadas por cliente+impuesto+período de acá en adelante.
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vencimientos_unico ON vencimientos(cliente_id, impuesto_id, periodo)`);

        // 5. Control Envíos
        db.run(`
            CREATE TABLE IF NOT EXISTS control_envios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                periodo TEXT UNIQUE NOT NULL,
                fecha_ejecucion DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 6. Montos por Categoría (para Monotributo y Autónomos)
        db.run(`
            CREATE TABLE IF NOT EXISTS montos_categorias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                impuesto_nombre TEXT NOT NULL,
                categoria TEXT NOT NULL,
                monto REAL NOT NULL,
                UNIQUE(impuesto_nombre, categoria)
            )
        `);

        // 7. Feriados: calendario oficial descargado por scraper.py (API nolaborables.com.ar).
        // scraper.py lo usa para no dejar un vencimiento cayendo en feriado.
        db.run(`
            CREATE TABLE IF NOT EXISTS feriados (
                fecha TEXT PRIMARY KEY,
                motivo TEXT,
                tipo TEXT
            )
        `);

        // 🧹 LIMPIEZA DE IMPUESTOS DUPLICADOS
        db.run(`DELETE FROM impuestos WHERE rowid NOT IN (SELECT MIN(rowid) FROM impuestos GROUP BY LOWER(TRIM(nombre)))`);

        // 🧹 Los impuestos manuales viejos que ahora tienen regla oficial se
        // convierten a automáticos y se renombran (evita quedar duplicados).
        db.run(`UPDATE impuestos SET nombre = 'Personal de Casas Particulares (Obligatorio)', tipo_agenda = 'automatica' WHERE nombre = 'Casas Particulares'`);

        // Lista limpia de impuestos oficiales
        const impuestosBase = [
            { nombre: 'Monotributo', tipo_agenda: 'automatica' },
            { nombre: 'Autónomos', tipo_agenda: 'automatica' },
            { nombre: 'IVA', tipo_agenda: 'automatica' },
            { nombre: 'Ingresos Brutos', tipo_agenda: 'automatica' }, // ⚠️ regla aproximada, no verificada
            { nombre: 'Empleadores (SICOSS)', tipo_agenda: 'automatica' },
            { nombre: 'Convenio Multilateral', tipo_agenda: 'automatica' },
            { nombre: 'Retenciones y/o Percepciones', tipo_agenda: 'automatica' },
            { nombre: 'Personal de Casas Particulares (Obligatorio)', tipo_agenda: 'automatica' },
            { nombre: 'Personal de Casas Particulares (Voluntario)', tipo_agenda: 'automatica' },
            { nombre: 'Ganancias Personas Humanas', tipo_agenda: 'automatica' },
            { nombre: 'Bienes Personales', tipo_agenda: 'automatica' },
            { nombre: 'Impuesto Cedular', tipo_agenda: 'automatica' },
            { nombre: 'Imp. Acciones y Participaciones', tipo_agenda: 'automatica' },
            { nombre: 'Rég. Inf. Participaciones Societarias', tipo_agenda: 'automatica' },
            { nombre: 'Tasa Municipal (Esperanza)', tipo_agenda: 'automatica' },
            { nombre: 'Ganancias Sociedades DDJJ', tipo_agenda: 'manual' }, // depende de cierre de ejercicio por cliente
            { nombre: 'Honorarios Contables', tipo_agenda: 'manual' }
        ];
        const stmt = db.prepare(`INSERT OR IGNORE INTO impuestos (nombre, tipo_agenda) VALUES (?, ?)`);
        impuestosBase.forEach(imp => stmt.run(imp.nombre, imp.tipo_agenda));
        stmt.finalize(() => {
            // Si el impuesto ya existía de una corrida anterior (INSERT OR IGNORE no lo tocó),
            // igual nos aseguramos de que tenga el tipo_agenda correcto.
            const stmtUpdate = db.prepare(`UPDATE impuestos SET tipo_agenda = ? WHERE nombre = ?`);
            impuestosBase.forEach(imp => stmtUpdate.run(imp.tipo_agenda, imp.nombre));
            stmtUpdate.finalize();
        });
    });
}

module.exports = db;