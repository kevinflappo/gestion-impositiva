import sqlite3
import datetime
import json
import urllib.request
import urllib.error
import os

def ruta_db():
    """
    Si Node seteó la variable de entorno DB_PATH (caso Electron: la DB vive en
    AppData, no al lado del código), la usamos. Si no, ruta relativa de siempre
    (caso node server.js corrido a mano, sin Electron).
    """
    return os.environ.get('DB_PATH', 'vencimientos.db')

# ============================================================
# FERIADOS Y DÍA HÁBIL (sin cambios de lógica)
# ============================================================

def asegurar_feriados_cargados(cursor, anio):
    """
    Descarga el calendario de feriados nacionales de Argentina para 'anio' si
    todavía no está en la base (se hace una sola vez por año, no en cada corrida).
    Usa la API pública y gratuita de nolaborables.com.ar (no requiere API key).
    Si falla (sin internet, DNS caído, la API no responde), no rompe el resto del
    scraper: sigue funcionando ajustando solo por fin de semana para ese año.
    """
    cursor.execute("SELECT COUNT(*) FROM feriados WHERE fecha LIKE ?", (f"{anio}-%",))
    if cursor.fetchone()[0] > 0:
        return  # ya están cargados, no volvemos a pegarle a la API

    url = f"https://nolaborables.com.ar/api/v2/feriados/{anio}"
    print(f"[+] Descargando feriados {anio} desde nolaborables.com.ar...")
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            feriados = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"[WARN] No se pudo descargar feriados de {anio} ({e}). "
              f"Los vencimientos DINÁMICOS de este año NO se van a ajustar por feriado "
              f"(solo por fin de semana) hasta que se carguen manualmente.")
        return

    for f in feriados:
        fecha_str = f"{anio}-{int(f['mes']):02d}-{int(f['dia']):02d}"
        cursor.execute(
            "INSERT OR IGNORE INTO feriados (fecha, motivo, tipo) VALUES (?, ?, ?)",
            (fecha_str, f.get('motivo', ''), f.get('tipo', ''))
        )
    print(f"[OK] {len(feriados)} feriados de {anio} cargados en la base.")

def es_feriado(cursor, fecha_str):
    cursor.execute("SELECT 1 FROM feriados WHERE fecha = ?", (fecha_str,))
    return cursor.fetchone() is not None

def obtener_ultimo_dia_habil(cursor, anio, mes, dia):
    """
    Ajusta la fecha al próximo día hábil: evita que caiga sábado, domingo o feriado.
    Avanza día por día hasta encontrar un día realmente hábil.
    Uso: SOLO para impuestos "dinámicos" (sin tabla oficial anual cargada).
    Los impuestos con tabla literal (ver abajo) NO pasan por acá: sus fechas ya
    vienen ajustadas por Errepar, volver a ajustarlas las correría de más.
    """
    fecha = datetime.date(anio, mes, dia)
    while fecha.weekday() >= 5 or es_feriado(cursor, fecha.strftime('%Y-%m-%d')):
        fecha += datetime.timedelta(days=1)
    return fecha.strftime('%Y-%m-%d')

def obtener_id_impuesto(cursor, nombre_impuesto):
    """ Busca dinámicamente el ID del impuesto por su nombre exacto en la base de datos """
    cursor.execute("SELECT id FROM impuestos WHERE nombre = ?", (nombre_impuesto,))
    resultado = cursor.fetchone()
    return resultado[0] if resultado else None

def upsert_agenda(cursor, impuesto_id, terminacion_cuit, periodo, fecha_vencimiento):
    """
    Guarda/actualiza la fecha oficial de vencimiento en agenda_impositiva.
    A diferencia de INSERT OR IGNORE, esto SÍ corrige la fecha si se vuelve a
    cargar con un valor distinto (ej: se corrige un typo de transcripción).
    """
    cursor.execute('''
        INSERT INTO agenda_impositiva (impuesto_id, terminacion_cuit, periodo, fecha_vencimiento)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(impuesto_id, terminacion_cuit, periodo) DO UPDATE SET
            fecha_vencimiento = excluded.fecha_vencimiento
    ''', (impuesto_id, terminacion_cuit, periodo, fecha_vencimiento))


# ============================================================
# AGRUPAMIENTOS POR TERMINACIÓN DE CUIT
# (cada impuesto de la tabla oficial usa un agrupamiento distinto)
# ============================================================

def grupo_4_3_3(term):
    """ Grupos: 0-3 / 4-6 / 7-9 (Autónomos, SICOSS, Retenciones, DDJJ anuales) """
    if term <= 3: return 0
    if term <= 6: return 1
    return 2

def grupo_iva(term):
    """ Grupos de a pares: 0-1 / 2-3 / 4-5 / 6-7 / 8-9 """
    return term // 2

def grupo_convenio(term):
    """ Grupos: 0-2 / 3-5 / 6-7 / 8-9 (Convenio Multilateral) """
    if term <= 2: return 0
    if term <= 5: return 1
    if term <= 7: return 2
    return 3


# ============================================================
# TABLAS OFICIALES 2026 (Errepar / RG ARCA - Boletín Oficial)
# Días YA ajustados a hábil por la editorial: NO se les vuelve a
# aplicar obtener_ultimo_dia_habil.
# ⚠️ Válidas solo para 2026. Actualizar con la agenda de cada año.
# ============================================================

TABLA_AUTONOMOS_2026 = {
    1: [5, 6, 7], 2: [5, 6, 9], 3: [5, 6, 9], 4: [6, 7, 8],
    5: [5, 6, 7], 6: [5, 8, 9], 7: [6, 7, 8], 8: [5, 6, 7],
    9: [7, 8, 9], 10: [5, 6, 7], 11: [5, 9, 10], 12: [9, 10, 11]
}

TABLA_MONOTRIBUTO_2026 = {
    1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 22,
    7: 20, 8: 20, 9: 21, 10: 20, 11: 20, 12: 21
}

TABLA_SICOSS_2026 = {
    1: [9, 12, 13], 2: [9, 10, 11], 3: [9, 10, 11], 4: [9, 10, 13],
    5: [11, 12, 13], 6: [9, 10, 11], 7: [13, 14, 15], 8: [10, 11, 12],
    9: [9, 10, 11], 10: [9, 13, 14], 11: [9, 10, 11], 12: [9, 10, 11]
}

TABLA_CONVENIO_MULTILATERAL_2026 = {
    1: [15, 16, 19, 20], 2: [13, 18, 19, 20], 3: [13, 16, 17, 18], 4: [15, 16, 17, 20],
    5: [15, 18, 19, 20], 6: [16, 17, 18, 19], 7: [15, 16, 17, 20], 8: [14, 18, 19, 20],
    9: [15, 16, 17, 18], 10: [15, 16, 19, 20], 11: [13, 16, 17, 18], 12: [15, 16, 17, 18]
}

TABLA_IVA_2026 = {
    1: [19, 20, 21, 22, 23], 2: [18, 19, 20, 23, 24], 3: [18, 19, 20, 25, 26],
    4: [20, 21, 22, 23, 24], 5: [18, 19, 20, 21, 22], 6: [18, 19, 22, 23, 24],
    7: [20, 21, 22, 23, 24], 8: [18, 19, 20, 21, 24], 9: [18, 21, 22, 23, 24],
    10: [19, 20, 21, 22, 23], 11: [18, 19, 20, 24, 25], 12: [18, 21, 22, 23, 28]
}

# Solo la 2da quincena (DDJJ e ingreso del saldo) — la 1ra quincena (pago a cuenta)
# no se carga porque, según confirmó Lionela, sus clientes no la pagan.
TABLA_RETENCIONES_PERCEPCIONES_2026 = {
    1: [9, 12, 13], 2: [9, 10, 11], 3: [9, 10, 11], 4: [9, 10, 13],
    5: [11, 12, 13], 6: [9, 10, 11], 7: [13, 14, 15], 8: [10, 11, 12],
    9: [9, 10, 11], 10: [9, 13, 14], 11: [9, 10, 11], 12: [9, 10, 11]
}

TABLA_CASAS_PARTICULARES_OBLIGATORIO_2026 = {
    1: 12, 2: 10, 3: 10, 4: 10, 5: 11, 6: 10,
    7: 13, 8: 10, 9: 10, 10: 13, 11: 10, 12: 10
}

TABLA_CASAS_PARTICULARES_VOLUNTARIO_2026 = {
    1: 15, 2: 18, 3: 16, 4: 15, 5: 15, 6: 16,
    7: 15, 8: 18, 9: 15, 10: 15, 11: 16, 12: 15
}


# ============================================================
# CARGADORES GENÉRICOS
# ============================================================

def cargar_tabla_mensual(cursor, impuesto_nombre, tabla_por_mes, funcion_grupo, anio):
    """ Impuesto mensual, con fecha distinta según grupo de terminación de CUIT. """
    impuesto_id = obtener_id_impuesto(cursor, impuesto_nombre)
    if not impuesto_id:
        print(f"[WARN] No se encontró el impuesto '{impuesto_nombre}' en la base, se omite su carga.")
        return
    for mes, dias in tabla_por_mes.items():
        periodo = f"{anio}-{mes:02d}"
        for term in range(10):
            dia = dias[funcion_grupo(term)]
            fecha = f"{anio}-{mes:02d}-{dia:02d}"
            upsert_agenda(cursor, impuesto_id, term, periodo, fecha)

def cargar_tabla_flat(cursor, impuesto_nombre, tabla_por_mes, anio):
    """ Impuesto mensual con un solo día por mes, igual para todas las terminaciones. """
    impuesto_id = obtener_id_impuesto(cursor, impuesto_nombre)
    if not impuesto_id:
        print(f"[WARN] No se encontró el impuesto '{impuesto_nombre}' en la base, se omite su carga.")
        return
    for mes, dia in tabla_por_mes.items():
        periodo = f"{anio}-{mes:02d}"
        fecha = f"{anio}-{mes:02d}-{dia:02d}"
        for term in range(10):
            upsert_agenda(cursor, impuesto_id, term, periodo, fecha)

def cargar_evento_anual(cursor, impuesto_nombre, mes, dias_por_grupo, funcion_grupo, anio):
    """ Obligación de una sola vez en el año (DDJJ anuales, regímenes informativos). """
    impuesto_id = obtener_id_impuesto(cursor, impuesto_nombre)
    if not impuesto_id:
        print(f"[WARN] No se encontró el impuesto '{impuesto_nombre}' en la base, se omite su carga.")
        return
    periodo = f"{anio}-{mes:02d}"
    for term in range(10):
        dia = dias_por_grupo[funcion_grupo(term)]
        fecha = f"{anio}-{mes:02d}-{dia:02d}"
        upsert_agenda(cursor, impuesto_id, term, periodo, fecha)


def cargar_agenda_literal_2026():
    """
    Carga TODO el año 2026 de una sola vez para los impuestos que tienen tabla
    oficial de Errepar (no requiere ventana de 3 meses: como es una tabla fija
    y no un cálculo, no cuesta nada cargar el año completo).
    """
    conn = sqlite3.connect(ruta_db())
    cursor = conn.cursor()
    anio = 2026

    cargar_tabla_mensual(cursor, 'Autónomos', TABLA_AUTONOMOS_2026, grupo_4_3_3, anio)
    cargar_tabla_flat(cursor, 'Monotributo', TABLA_MONOTRIBUTO_2026, anio)
    cargar_tabla_mensual(cursor, 'IVA', TABLA_IVA_2026, grupo_iva, anio)
    cargar_tabla_mensual(cursor, 'Empleadores (SICOSS)', TABLA_SICOSS_2026, grupo_4_3_3, anio)
    cargar_tabla_mensual(cursor, 'Convenio Multilateral', TABLA_CONVENIO_MULTILATERAL_2026, grupo_convenio, anio)
    cargar_tabla_mensual(cursor, 'Retenciones y/o Percepciones', TABLA_RETENCIONES_PERCEPCIONES_2026, grupo_4_3_3, anio)
    cargar_tabla_flat(cursor, 'Personal de Casas Particulares (Obligatorio)', TABLA_CASAS_PARTICULARES_OBLIGATORIO_2026, anio)
    cargar_tabla_flat(cursor, 'Personal de Casas Particulares (Voluntario)', TABLA_CASAS_PARTICULARES_VOLUNTARIO_2026, anio)

    # Obligaciones anuales de una sola vez (período fiscal 2025, vencen en 2026).
    # Se usa la fecha de DDJJ (la más temprana); el pago vence unos días después.
    cargar_evento_anual(cursor, 'Ganancias Personas Humanas', 6, [11, 12, 16], grupo_4_3_3, anio)
    cargar_evento_anual(cursor, 'Bienes Personales', 6, [11, 12, 16], grupo_4_3_3, anio)
    cargar_evento_anual(cursor, 'Impuesto Cedular', 6, [11, 12, 16], grupo_4_3_3, anio)
    cargar_evento_anual(cursor, 'Imp. Acciones y Participaciones', 6, [11, 12, 16], grupo_4_3_3, anio)
    cargar_evento_anual(cursor, 'Rég. Inf. Participaciones Societarias', 7, [28, 29, 30], grupo_4_3_3, anio)

    conn.commit()
    conn.close()
    print(f"[OK] Agenda literal {anio} (Errepar) cargada para todos los impuestos con tabla oficial.")


# ============================================================
# IMPUESTOS DINÁMICOS (sin tabla anual: se calculan por fórmula,
# ventana rodante de 3 meses, como antes)
# ============================================================

def sincronizar_calendarios_dinamicos(anio=None, mes=None):
    conn = sqlite3.connect(ruta_db())
    cursor = conn.cursor()

    hoy = datetime.date.today()
    if not anio: anio = hoy.year
    if not mes: mes = hoy.month

    periodo = f"{anio}-{mes:02d}"
    print(f"[+] Sincronizando agenda DINÁMICA para el período: {periodo}...")

    asegurar_feriados_cargados(cursor, anio)

    # INGRESOS BRUTOS (API Santa Fe) - Vence del 15 al 19 según pareja.
    # ⚠️ Regla aproximada propia (no está en el calendario federal de Errepar,
    # que es de ARCA/AFIP; IIBB es provincial). Falta verificar contra la agenda oficial de API.
    id_iibb = obtener_id_impuesto(cursor, 'Ingresos Brutos')
    if id_iibb:
        for term in range(10):
            dia_base = 15 + (term // 2)
            fecha_iibb = obtener_ultimo_dia_habil(cursor, anio, mes, dia_base)
            upsert_agenda(cursor, id_iibb, term, periodo, fecha_iibb)

    # TASA MUNICIPAL (Esperanza) - Vence el día 12 para todos, sin importar el CUIT.
    id_tasa = obtener_id_impuesto(cursor, 'Tasa Municipal (Esperanza)')
    if id_tasa:
        fecha_tasa = obtener_ultimo_dia_habil(cursor, anio, mes, 12)
        for term in range(10):
            upsert_agenda(cursor, id_tasa, term, periodo, fecha_tasa)

    conn.commit()
    conn.close()
    print(f"[OK] Agenda dinámica para {periodo} actualizada correctamente.")


if __name__ == '__main__':
    try:
        cargar_agenda_literal_2026()
    except Exception as e:
        print(f"[ERROR] cargando agenda literal 2026: {e}")

    try:
        # Genera el mes actual y los 2 meses siguientes para los impuestos dinámicos
        hoy = datetime.date.today()
        for i in range(3):
            mes_calculado = hoy.month + i
            anio_target = hoy.year + (mes_calculado - 1) // 12
            mes_target = (mes_calculado - 1) % 12 + 1

            sincronizar_calendarios_dinamicos(anio_target, mes_target)
    except Exception as e:
        print(f"[ERROR]: {e}")