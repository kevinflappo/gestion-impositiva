const { execFile } = require('child_process');
const path = require('path');

// Permite forzar el binario vía .env (PYTHON_BIN=python3.11, por ejemplo).
// Si no se define, usamos 'python' en Windows y 'python3' en el resto (Linux/Mac),
// que es la convención estándar en cada plataforma.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

/**
 * Ejecuta el script scraper.py en la raíz para actualizar 
 * la agenda de ARCA y los montos por categoría en la base de datos.
 */
function ejecutarScraperARCA() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.resolve(__dirname, '../scraper.py');
        console.log(`🔄 [SCRAPER] Iniciando actualización de fechas y montos desde ARCA (usando "${PYTHON_BIN}")...`);

        execFile(PYTHON_BIN, [scriptPath], (error, stdout, stderr) => {
            if (error) {
                // ENOENT = el binario no existe en el PATH. Damos un mensaje claro para no perder tiempo debuggeando.
                if (error.code === 'ENOENT') {
                    console.error(`❌ [SCRAPER] No se encontró el comando "${PYTHON_BIN}". Verificá que Python esté instalado y en el PATH, o definí PYTHON_BIN en tu .env (ej: PYTHON_BIN=python3.11).`);
                } else {
                    console.error(`❌ [SCRAPER] Error al ejecutar scraper.py: ${error.message}`);
                }
                return reject(error);
            }
            if (stderr) {
                console.warn(`⚠️ [SCRAPER] Advertencia durante la ejecución: ${stderr}`);
            }
            console.log(`✅ [SCRAPER] Actualización completada exitosamente:\n${stdout}`);
            resolve(stdout);
        });
    });
}

module.exports = {
    ejecutarScraperARCA
};