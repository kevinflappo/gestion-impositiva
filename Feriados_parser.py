"""
feriados_parser.py

Extrae el listado de feriados de un PDF de feriadosargentina.com.ar y lo
imprime como JSON por stdout. No toca la base de datos: solo parsea.
La confirmación/carga a la tabla `feriados` la hace el endpoint de Node
después de que el usuario revisa el resultado.

Uso: python feriados_parser.py /ruta/al/archivo.pdf
"""
import sys
import json
import re

MESES = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
    'julio': 7, 'agosto': 8, 'septiembre': 9, 'setiembre': 9, 'octubre': 10,
    'noviembre': 11, 'diciembre': 12
}

PATRON_FERIADO = re.compile(
    r'^(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\s+'
    r'(\d{1,2})\s+de\s+(\w+)\s+(.+?)\s+'
    r'(Inamovible|Trasladable|Tur[íi]stico)\s*$',
    re.IGNORECASE
)


def parsear_pdf(ruta_pdf):
    import pdfplumber  # import acá para que el error de import quede en el try/except del caller

    with pdfplumber.open(ruta_pdf) as pdf:
        texto = "\n".join(page.extract_text() or '' for page in pdf.pages)

    # Detectar año del título del PDF ("Feriados Argentina 2026"). Si no lo
    # encuentra, devuelve error explícito en vez de adivinar un año.
    m_anio = re.search(r'Feriados Argentina (\d{4})', texto)
    if not m_anio:
        return {"error": "No se pudo detectar el año en el PDF. Verificá que sea un calendario de feriadosargentina.com.ar."}
    anio = int(m_anio.group(1))

    feriados = []
    for linea in texto.split('\n'):
        match = PATRON_FERIADO.match(linea.strip())
        if match:
            _dia_semana, dia, mes_nombre, motivo, tipo = match.groups()
            mes_num = MESES.get(mes_nombre.lower())
            if mes_num:
                fecha = f"{anio}-{mes_num:02d}-{int(dia):02d}"
                feriados.append({"fecha": fecha, "motivo": motivo.strip(), "tipo": tipo})

    if not feriados:
        return {"error": "No se encontraron feriados en el PDF. ¿Es el formato de feriadosargentina.com.ar?"}

    return {"anio": anio, "feriados": feriados}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Falta la ruta del PDF."}))
        sys.exit(1)

    try:
        resultado = parsear_pdf(sys.argv[1])
        print(json.dumps(resultado, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"Error parseando el PDF: {str(e)}"}))
        sys.exit(1)