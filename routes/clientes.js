const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET /api/clientes - Listar todos los clientes con sus impuestos
router.get('/', (req, res) => {
    const sql = `
        SELECT 
            c.id, c.razon_social, c.cuit, c.clave_fiscal, c.telefono, c.email_notificacion,
            GROUP_CONCAT(i.nombre || CASE WHEN ci.categoria IS NOT NULL AND ci.categoria != '' THEN ' (' || ci.categoria || ')' ELSE '' END, ', ') AS impuestos_asignados
        FROM clientes c
        LEFT JOIN cliente_impuestos ci ON c.id = ci.cliente_id
        LEFT JOIN impuestos i ON ci.impuesto_id = i.id
        GROUP BY c.id
        ORDER BY c.razon_social ASC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// POST /api/clientes - Crear nuevo cliente
router.post('/', (req, res) => {
    const { razon_social, cuit, clave_fiscal, telefono, email_notificacion } = req.body;

    if (!razon_social || !cuit) {
        return res.status(400).json({ error: 'La Razón Social y el CUIT son obligatorios.' });
    }

    const sql = `INSERT INTO clientes (razon_social, cuit, clave_fiscal, telefono, email_notificacion) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [razon_social.trim(), cuit.trim(), clave_fiscal?.trim() || '', telefono?.trim() || '', email_notificacion?.trim() || ''], function(err) {
        if (err) {
            console.error('❌ Error al insertar cliente:', err.message);
            return res.status(400).json({ error: err.message });
        }
        res.json({ id: this.lastID, mensaje: 'Cliente guardado con éxito' });
    });
});

// DELETE /api/clientes/:id - Eliminar cliente
router.delete('/:id', (req, res) => {
    const { id } = req.params;

    db.run(`DELETE FROM clientes WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Limpiar dependencias
        db.run(`DELETE FROM cliente_impuestos WHERE cliente_id = ?`, [id]);
        db.run(`DELETE FROM vencimientos WHERE cliente_id = ?`, [id]);

        res.json({ mensaje: 'Cliente y sus datos asociados eliminados correctamente.' });
    });
});

// En routes/clientes.js, reemplazar la ruta PUT por:
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { clave_fiscal, telefono, email_notificacion } = req.body;

    const sql = `UPDATE clientes SET clave_fiscal = ?, telefono = ?, email_notificacion = ? WHERE id = ?`;
    
    db.run(sql, [clave_fiscal, telefono, email_notificacion, id], function(err) {
        if (err) {
            console.error('❌ Error actualizando cliente:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, cambios: this.changes });
    });
});
module.exports = router;