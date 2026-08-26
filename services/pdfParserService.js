const { execFile } = require('child_process');
const path = require('path');

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

/**
 * Ejecuta feriados_parser.py sobre un PDF subido y devuelve la estructura
 * { anio, feriados: [{fecha, motivo, tipo}, ...] }.
 * NO escribe en la base — solo parsea. La confirmación la hace el endpoint
 * de Node después de que el usuario revisa el resultado en la interfaz.
 */
function parsearFeriadosPDF(rutaPdf) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.resolve(__dirname, '../feriados_parser.py');

        execFile(PYTHON_BIN, [scriptPath, rutaPdf], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                return reject(new Error(`No se encontró el comando "${PYTHON_BIN}". Verificá que Python esté instalado y en el PATH.`));
            }
            let resultado;
            try {
                resultado = JSON.parse(stdout);
            } catch (parseErr) {
                return reject(new Error(`Respuesta inesperada del parser: ${stderr || stdout || parseErr.message}`));
            }
            if (resultado.error) return reject(new Error(resultado.error));
            resolve(resultado);
        });
    });
}

/**
 * Ejecuta errepar_parser.py sobre un PDF de calendario de vencimientos y
 * devuelve { anio, cantidad_filas, filas: [{impuesto, periodo, terminacion_cuit, fecha_vencimiento}, ...] }.
 * NO escribe en la base — mismo patrón que parsearFeriadosPDF.
 * El año NO se detecta del PDF (el título es una imagen): se pasa siempre explícito.
 */
function parsearErreparPDF(rutaPdf, anio) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.resolve(__dirname, '../errepar_parser.py');

        execFile(PYTHON_BIN, [scriptPath, rutaPdf, String(anio)], { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                return reject(new Error(`No se encontró el comando "${PYTHON_BIN}". Verificá que Python esté instalado y en el PATH.`));
            }
            let resultado;
            try {
                resultado = JSON.parse(stdout);
            } catch (parseErr) {
                return reject(new Error(`Respuesta inesperada del parser: ${stderr || stdout || parseErr.message}`));
            }
            if (resultado.error) return reject(new Error(resultado.error));
            resolve(resultado);
        });
    });
}

module.exports = { parsearFeriadosPDF, parsearErreparPDF };