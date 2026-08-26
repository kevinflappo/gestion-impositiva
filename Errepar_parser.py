"""
errepar_parser.py

Extrae el calendario de vencimientos de un PDF de Errepar (formato "Calendario
de Vencimientos AAAA") y lo imprime como JSON por stdout. No toca la base de
datos: solo parsea. La carga a `agenda_impositiva` la hace el endpoint de Node
después de que el usuario revisa el resultado en la interfaz.

Uso: python errepar_parser.py /ruta/al/archivo.pdf 2026

El año NO se detecta automáticamente (el título del PDF es una imagen, no
texto extraíble de forma confiable) — se pasa siempre como argumento explícito.

Impuestos que este parser SABE reconocer (deben existir en la tabla `impuestos`
con esos nombres exactos, sensible a mayúsculas/tildes):
  Autónomos, Monotributo, IVA, Empleadores (SICOSS), Convenio Multilateral,
  Retenciones y/o Percepciones (solo 2da quincena), Personal de Casas
  Particulares (Obligatorio/Voluntario), Ganancias Personas Humanas,
  Bienes Personales, Impuesto Cedular, Imp. Acciones y Participaciones,
  Rég. Inf. Participaciones Societarias.

Columnas que el PDF trae pero este parser NO carga a propósito (falta
lógica de negocio, ej. depende del cierre de ejercicio del cliente):
  Ganancias Sociedades DDJJ, Anticipos, Internos, Retenciones 1ra quincena.
"""
import sys
import json
import re
import unicodedata

MESES = {
    'ENERO': 1, 'FEBRERO': 2, 'MARZO': 3, 'ABRIL': 4, 'MAYO': 5, 'JUNIO': 6,
    'JULIO': 7, 'AGOSTO': 8, 'SETIEMBRE': 9, 'SEPTIEMBRE': 9, 'OCTUBRE': 10,
    'NOVIEMBRE': 11, 'DICIEMBRE': 12
}
MESES_ABREV = {'ENE': 1, 'FEB': 2, 'MAR': 3, 'ABR': 4, 'MAY': 5, 'JUN': 6,
               'JUL': 7, 'AGO': 8, 'SET': 9, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DIC': 12}

MAPEO_IMPUESTOS = [
    ('AUTONOMOS', None, 'Autónomos'),
    ('MONOTRIBUTO', None, 'Monotributo'),
    ('EMPLEADORES', None, 'Empleadores (SICOSS)'),
    ('CONVENIOMULTILATERAL', None, 'Convenio Multilateral'),
    ('IVA', None, 'IVA'),
    ('RETENCIONES', '2AQUINCENA', 'Retenciones y/o Percepciones'),
]


def quitar_acentos(txt):
    return ''.join(c for c in unicodedata.normalize('NFD', txt) if unicodedata.category(c) != 'Mn')


def normalizar(txt):
    if not txt:
        return ''
    t = quitar_acentos(txt.replace('\n', ' '))
    return re.sub(r'\s+', ' ', t).strip().upper()


def compacto(txt):
    """ Sin espacios (soporta texto vertical letra por letra, ej "M\\nO\\nN..." de Monotributo) """
    return re.sub(r'\s+', '', normalizar(txt))


def forward_fill(fila):
    """ Propaga el último valor no vacío hacia la derecha (para celdas fusionadas en el PDF) """
    resultado, ultimo = [], None
    for celda in fila:
        if celda is not None and str(celda).strip() != '':
            ultimo = celda
        resultado.append(ultimo)
    return resultado


def parsear_rango_cuit(texto):
    """ '0 a 3' -> [0,1,2,3] | '0 - 2' -> [0,1,2] | '0-1-2-3' -> [0,1,2,3] """
    if not texto:
        return []
    t = texto.strip()
    m = re.match(r'^(\d)\s*(?:a|-)\s*(\d)$', t)
    if m:
        return list(range(int(m.group(1)), int(m.group(2)) + 1))
    if re.match(r'^\d(-\d)+$', t):
        return [int(x) for x in re.findall(r'\d', t)]
    m = re.match(r'^(\d)$', t)
    if m:
        return [int(m.group(1))]
    return []


def resolver_impuesto(header_grupo, header_subgrupo, cuit_label):
    hg = compacto(header_grupo)
    hs = compacto(header_subgrupo)

    if 'PERSONAL' in hg and 'CASAS' in hg:
        cl = compacto(cuit_label)
        if 'OBLIG' in cl:
            return 'Personal de Casas Particulares (Obligatorio)'
        if 'VOLUNT' in cl:
            return 'Personal de Casas Particulares (Voluntario)'
        return None

    for substr, sub_requerido, nombre in MAPEO_IMPUESTOS:
        if substr in hg:
            if sub_requerido and sub_requerido not in hs:
                continue
            return nombre
    return None


def extraer_tabla_mensual(tabla, anio):
    """ La tabla grande: un impuesto por mes, agrupado por terminación de CUIT. """
    fila_grupo = forward_fill(tabla[0])
    fila_subgrupo = forward_fill(tabla[1])
    fila_cuit = tabla[2]

    columnas = []
    for i in range(1, len(fila_cuit)):
        impuesto = resolver_impuesto(fila_grupo[i], fila_subgrupo[i], fila_cuit[i])
        if not impuesto:
            continue
        digitos = parsear_rango_cuit(fila_cuit[i])
        if 'Casas Particulares' in impuesto and not digitos:
            digitos = list(range(10))  # no distingue por CUIT: aplica a todas las terminaciones
        columnas.append({'idx': i, 'impuesto': impuesto, 'digitos': digitos})

    resultado = {}
    for fila in tabla[3:]:
        mes_num = MESES.get(compacto(fila[0])) if fila[0] else None
        if not mes_num:
            continue
        periodo = f"{anio}-{mes_num:02d}"

        for col in columnas:
            valor_raw = fila[col['idx']] if col['idx'] < len(fila) else None
            if not valor_raw:
                continue
            m = re.match(r'^(\d{1,2})', str(valor_raw).strip())
            if not m:
                continue
            dia = int(m.group(1))
            fecha = f"{anio}-{mes_num:02d}-{dia:02d}"

            resultado.setdefault(col['impuesto'], {}).setdefault(periodo, {})
            for d in col['digitos']:
                resultado[col['impuesto']][periodo][d] = fecha

    return resultado


def procesar_tabla_anual(tabla_raw, anio):
    """
    Las 3 tablas chicas (eventos de una sola vez al año). Soporta 2 formatos:
    - Con sub-fila DDJJ/PAGO (Ganancias PH, Acciones): se usa el valor de DDJJ.
    - Sin sub-fila (Régimen de Información): un único valor por grupo.
    """
    fila_headers = tabla_raw[1]
    patron_grupo = re.compile(r'^\d(-\d)+$')

    idx_inicio_grupos = None
    for i, celda in enumerate(fila_headers):
        if celda and patron_grupo.match(celda.strip()):
            idx_inicio_grupos = i
            break
    if idx_inicio_grupos is None:
        return None

    grupos = [parsear_rango_cuit(fila_headers[i]) for i in range(idx_inicio_grupos, len(fila_headers))]

    mes_nombre, fila_datos = None, None
    for fila in tabla_raw[2:]:
        if fila[0]:
            mes_nombre = fila[0]
        if idx_inicio_grupos >= 2:
            sub_label = (fila[idx_inicio_grupos - 1] or '').upper()
            if 'DDJJ' in sub_label:
                fila_datos = fila
                break
        else:
            fila_datos = fila
            break

    if not fila_datos or not mes_nombre:
        return None

    mes_num = next((n for p, n in MESES_ABREV.items() if mes_nombre.upper().startswith(p)), None)
    if not mes_num:
        return None

    periodo = f"{anio}-{mes_num:02d}"
    resultado = {periodo: {}}
    for offset, grupo_digitos in enumerate(grupos):
        if not grupo_digitos:
            continue
        idx = idx_inicio_grupos + offset
        valor = fila_datos[idx] if idx < len(fila_datos) else None
        if not valor:
            continue
        m = re.match(r'^(\d{1,2})', str(valor).strip())
        if not m:
            continue
        dia = int(m.group(1))
        fecha = f"{anio}-{mes_num:02d}-{dia:02d}"
        for d in grupo_digitos:
            resultado[periodo][d] = fecha
    return resultado


def parsear_pdf(ruta_pdf, anio):
    import pdfplumber

    with pdfplumber.open(ruta_pdf) as pdf:
        page = pdf.pages[0]
        tablas = page.find_tables()

    if len(tablas) < 1:
        return {"error": "No se detectó ninguna tabla en el PDF. ¿Es el calendario anual de Errepar?"}

    resultado = {}

    # Tabla grande (mensual)
    resultado.update(extraer_tabla_mensual(tablas[0].extract(), anio))

    # Tablas anuales (Régimen de Información, Ganancias PH/Bienes/Cedular, Acciones y Participaciones)
    nombres_anuales = [
        'Rég. Inf. Participaciones Societarias',
        ['Ganancias Personas Humanas', 'Bienes Personales', 'Impuesto Cedular'],  # comparten fecha
        'Imp. Acciones y Participaciones',
    ]
    for i, nombre in enumerate(nombres_anuales, start=1):
        if i >= len(tablas):
            continue
        datos = procesar_tabla_anual(tablas[i].extract(), anio)
        if not datos:
            continue
        nombres = nombre if isinstance(nombre, list) else [nombre]
        for n in nombres:
            resultado.setdefault(n, {}).update(datos)

    if not resultado:
        return {"error": "No se pudo extraer ningún impuesto reconocido del PDF."}

    # Convertimos a una lista plana, más fácil de mostrar/editar en la interfaz:
    # [{impuesto, periodo, terminacion_cuit, fecha_vencimiento}, ...]
    filas = []
    for impuesto, periodos in resultado.items():
        for periodo, dias in periodos.items():
            for term, fecha in dias.items():
                filas.append({
                    "impuesto": impuesto,
                    "periodo": periodo,
                    "terminacion_cuit": term,
                    "fecha_vencimiento": fecha
                })
    filas.sort(key=lambda f: (f["impuesto"], f["periodo"], f["terminacion_cuit"]))

    return {"anio": anio, "cantidad_filas": len(filas), "filas": filas}


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Uso: python errepar_parser.py <ruta_pdf> <anio>"}))
        sys.exit(1)

    try:
        anio = int(sys.argv[2])
    except ValueError:
        print(json.dumps({"error": "El año debe ser un número (ej: 2026)."}))
        sys.exit(1)

    try:
        resultado = parsear_pdf(sys.argv[1], anio)
        print(json.dumps(resultado, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"Error parseando el PDF: {str(e)}"}))
        sys.exit(1)